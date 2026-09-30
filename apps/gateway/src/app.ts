import { GatewayError, newRequestId, redactHeaders } from '@ai-gateway/core';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { GatewayContext } from './context.js';
import { sendError } from './errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerPlaygroundRoutes } from './routes/playground.js';
import { registerV1Routes } from './routes/v1.js';

export interface BuildAppOptions {
  /** Disable Fastify's own logger; the gateway logs through its own redacting logger. */
  fastifyLogger?: boolean;
}

/**
 * Build the HTTP surface.
 *
 * Fastify's own logger is off by default: it would write request headers, and
 * the Authorization header carries a live API key. Everything that reaches a log
 * here goes through the gateway's redacting logger instead.
 */
export async function buildApp(
  ctx: GatewayContext,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.fastifyLogger ?? false,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: ctx.config.maxRequestBytes,
    // A streaming response can outlive the default; the per-request deadline is
    // enforced by the pipeline, not by the HTTP server.
    requestTimeout: 0,
    keepAliveTimeout: 72_000,
    genReqId: () => newRequestId(),
  });

  /**
   * Treat an empty JSON body as `{}`.
   *
   * Several endpoints take no input at all - probing a provider, resetting
   * circuits - and `curl -X POST` with no `-d` is the obvious way to call them.
   * Fastify's default parser rejects that with a 400, which is a bad API.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  if (ctx.config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: ctx.config.corsOrigins,
      credentials: true,
      allowedHeaders: ['authorization', 'content-type', 'x-api-key'],
      exposedHeaders: [
        'x-request-id',
        'x-gateway-provider',
        'x-gateway-model',
        'x-gateway-strategy',
        'x-gateway-cache',
        'x-gateway-attempts',
        'x-gateway-usage-source',
        'x-gateway-estimated-cost',
        'x-ratelimit-limit-requests',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-reset-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-tokens',
        'retry-after',
      ],
    });
  }

  app.addHook('onRequest', async (request) => {
    ctx.logger.debug('request received', {
      method: request.method,
      path: request.url.split('?')[0],
      headers: redactHeaders(request.headers as Record<string, unknown>),
    });
  });

  // Fastify's default 404 body is not the gateway's error envelope; make it one
  // so a client's error handling works uniformly.
  app.setNotFoundHandler(async (request, reply) => {
    await sendError(
      reply,
      new GatewayError(
        'invalid_request',
        `No route for ${request.method} ${request.url.split('?')[0]}.`,
      ),
      newRequestId(),
    );
  });

  app.setErrorHandler(async (rawError, request, reply) => {
    const requestId = String(request.id);
    const error = rawError as Error & { statusCode?: number; code?: string };

    // Fastify's own validation and payload errors carry a statusCode; map them
    // into the normalized taxonomy rather than leaking Fastify's shape.
    const status = error.statusCode;
    if (status === 413) {
      return sendError(
        reply,
        new GatewayError('payload_too_large', 'Request body is too large.'),
        requestId,
      );
    }
    if (status === 400 && error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return sendError(
        reply,
        new GatewayError('invalid_request', 'Request body is required.'),
        requestId,
      );
    }
    if (status === 400) {
      return sendError(reply, new GatewayError('invalid_request', error.message), requestId);
    }
    if (status === 415) {
      return sendError(
        reply,
        new GatewayError('invalid_request', 'Content-Type must be application/json.'),
        requestId,
      );
    }

    ctx.logger.error('unhandled request error', {
      requestId,
      path: request.url.split('?')[0],
      error: error.message,
    });
    return sendError(reply, error, requestId);
  });

  await registerOpsRoutes(app, ctx);
  await registerV1Routes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerPlaygroundRoutes(app, ctx);

  return app;
}
