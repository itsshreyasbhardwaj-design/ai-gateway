import { GatewayError, type GatewayErrorBody } from '@ai-gateway/core';
import type { FastifyReply } from 'fastify';

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * Validation failures are the caller's problem, not the gateway's.
 *
 * Admin routes validate their bodies with zod, which throws a ZodError rather
 * than a GatewayError. Without this it reached the error handler as an
 * unhandled exception and became a 500, which is both wrong and unhelpful.
 */
function asValidationError(err: unknown): GatewayError | undefined {
  const candidate = err as { name?: string; issues?: ZodLikeIssue[] } | null;
  if (!candidate || candidate.name !== 'ZodError' || !Array.isArray(candidate.issues)) return undefined;

  const first = candidate.issues[0];
  const path = first?.path.join('.') ?? '';
  return new GatewayError(
    'invalid_request',
    path ? `Invalid request: ${path} ${first?.message ?? 'is invalid'}` : `Invalid request: ${first?.message ?? 'failed validation'}`,
    {
      details: {
        ...(path ? { param: path } : {}),
        issues: candidate.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    },
  );
}

/**
 * Turn any thrown value into the normalized error envelope.
 *
 * Two invariants: the caller always gets a `requestId` they can quote in a
 * support request, and the body never contains a provider's raw error text
 * (which can echo the caller's own prompt back through logs).
 */
export function toErrorResponse(err: unknown, requestId: string): { status: number; body: GatewayErrorBody } {
  const gatewayError = asValidationError(err) ?? GatewayError.from(err);
  gatewayError.requestId ??= requestId;
  return { status: gatewayError.status, body: gatewayError.toBody() };
}

export async function sendError(reply: FastifyReply, err: unknown, requestId: string): Promise<void> {
  const { status, body } = toErrorResponse(err, requestId);
  const gatewayError = GatewayError.is(err) ? err : undefined;
  if (gatewayError?.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(gatewayError.retryAfterSeconds));
  }
  reply.header('x-request-id', requestId);
  await reply.status(status).send(body);
}

/**
 * Error frame for a stream that has already sent its headers.
 *
 * Once a 200 and the first chunk are out the status code cannot be changed, so
 * failures are reported in-band and the stream is terminated. Clients that only
 * parse `choices` see a truncated response; clients that check for `error` get
 * the full detail.
 */
export function streamErrorFrame(err: unknown, requestId: string): string {
  const { body } = toErrorResponse(err, requestId);
  return `data: ${JSON.stringify(body)}\n\n`;
}
