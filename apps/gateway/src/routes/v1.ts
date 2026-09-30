import {
  chatRequestSchema,
  embeddingsRequestSchema,
  GatewayError,
  newRequestId,
  parseOrThrow,
  type ChatRequest,
  type EmbeddingsRequest,
} from '@ai-gateway/core';
import { Readable } from 'node:stream';
import { DEFAULT_POLICY, permittedModels } from '@ai-gateway/policies';
import { rulesFromPolicy } from '@ai-gateway/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, requireScopes, type AuthenticatedKey } from '../auth.js';
import type { GatewayContext } from '../context.js';
import { sendError } from '../errors.js';
import { ChatPipeline } from '../pipeline/chat.js';
import { EmbeddingsPipeline } from '../pipeline/embeddings.js';
import { loadTenant } from '../pipeline/tenant.js';

/**
 * The OpenAI-compatible surface.
 *
 * The contract is that changing a base URL is the only change an application
 * needs: request and response shapes match, streaming matches, and everything
 * the gateway adds lives under a `gateway` key or an `x-gateway-*` header so no
 * existing client parser breaks.
 */
export async function registerV1Routes(app: FastifyInstance, ctx: GatewayContext): Promise<void> {
  const chatPipeline = new ChatPipeline(ctx);
  const embeddingsPipeline = new EmbeddingsPipeline(ctx);

  const auth = async (request: FastifyRequest): Promise<AuthenticatedKey> =>
    authenticate(
      { store: ctx.store, pepper: ctx.config.apiKeyPepper, cache: ctx.authCache },
      request.headers.authorization ?? (request.headers['x-api-key'] as string | undefined),
    );

  // ------------------------------------------------- chat completions

  const handleChat = async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = newRequestId();
    try {
      const identity = await auth(request);
      requireScopes(identity, 'inference.create');

      const parsed = parseOrThrow(chatRequestSchema, request.body, 'chat request') as ChatRequest;
      // OpenAI's stream_options.include_usage is accepted and satisfied by
      // default, since the gateway always emits usage on the final chunk.
      const bytes = Number(request.headers['content-length'] ?? 0);
      if (bytes > ctx.config.maxRequestBytes) {
        throw new GatewayError(
          'payload_too_large',
          `Request body of ${bytes} bytes exceeds the gateway limit of ${ctx.config.maxRequestBytes}.`,
        );
      }

      const signal = abortSignalFor(request);
      const result = await chatPipeline.run({
        auth: identity,
        request: parsed,
        requestId,
        signal,
        userAgent: request.headers['user-agent'],
        requestBytes: bytes,
        endpoint: request.url.startsWith('/v1/responses')
          ? '/v1/responses'
          : '/v1/chat/completions',
      });

      if (result.kind === 'json') {
        for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
        return reply.status(200).send(result.body);
      }

      // Headers are set through Fastify, not reply.raw: writing the raw socket
      // early would bypass them entirely. Fastify flushes them as soon as the
      // stream produces its first chunk.
      for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
      return reply.status(200).send(toNodeStream(result.frames));
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  };

  app.post('/v1/chat/completions', handleChat);

  /**
   * `/v1/responses` accepts the same body as `/v1/chat/completions`.
   *
   * The two are recorded separately so analytics can tell them apart, but the
   * gateway does not implement OpenAI's stateful Responses semantics
   * (server-side conversation storage, `previous_response_id`); a request using
   * those fields is rejected rather than silently ignoring them.
   */
  app.post('/v1/responses', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const unsupported = ['previous_response_id', 'store', 'conversation'].filter(
      (key) => body?.[key] !== undefined,
    );
    if (unsupported.length > 0) {
      return sendError(
        reply,
        new GatewayError(
          'invalid_request',
          `This gateway implements /v1/responses as a chat-completions-compatible endpoint and does not support stateful fields: ${unsupported.join(', ')}.`,
          { details: { unsupported } },
        ),
        newRequestId(),
      );
    }
    return handleChat(request, reply);
  });

  // ------------------------------------------------------- embeddings

  app.post('/v1/embeddings', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await auth(request);
      requireScopes(identity, 'inference.create');
      const parsed = parseOrThrow(
        embeddingsRequestSchema,
        request.body,
        'embeddings request',
      ) as EmbeddingsRequest;
      const result = await embeddingsPipeline.run({
        auth: identity,
        request: parsed,
        requestId,
        signal: abortSignalFor(request),
        userAgent: request.headers['user-agent'],
      });
      for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
      return reply.status(200).send(result.body);
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });

  // ----------------------------------------------------------- models

  /**
   * `GET /v1/models` returns only what this API key is permitted to use, in
   * OpenAI's shape, with the gateway's extra metadata under `gateway`.
   */
  app.get('/v1/models', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await auth(request);
      requireScopes(identity, 'models.read');

      const [organization, project] = await Promise.all([
        ctx.store.getOrganization(identity.organizationId),
        ctx.store.getProject(identity.projectId),
      ]);

      const registered = ctx.providers.listModels();
      const permitted = new Set(
        permittedModels({
          auth: identity,
          organizationAllowedModels: organization?.allowedModels,
          organizationDeniedModels: organization?.deniedModels,
          projectAllowedModels: project?.allowedModels,
          projectDeniedModels: project?.deniedModels,
          policy: DEFAULT_POLICY,
          registeredModels: registered.map((m) => m.id),
        }),
      );

      const data = registered
        .filter((model) => permitted.has(model.id))
        .map((model) => {
          const pricing = ctx.pricing.toRecord(model.id);
          return {
            id: model.id,
            object: 'model' as const,
            created: Math.floor(
              Date.parse(organization?.createdAt ?? new Date().toISOString()) / 1000,
            ),
            owned_by: model.providerId,
            gateway: {
              displayName: model.displayName,
              provider: model.providerId,
              providerModelId: model.providerModelId,
              contextWindow: model.contextWindow,
              maxOutputTokens: model.maxOutputTokens,
              capabilities: model.capabilities,
              status: model.status,
              family: model.family,
              // Pricing is configuration; the response says where it came from
              // and when it was last verified so nobody treats it as a quote.
              pricing: pricing
                ? {
                    inputPerMillionTokens: pricing.inputPerMillionTokens,
                    outputPerMillionTokens: pricing.outputPerMillionTokens,
                    cachedInputPerMillionTokens: pricing.cachedInputPerMillionTokens,
                    currency: pricing.currency,
                    version: pricing.pricingVersion,
                    source: pricing.source,
                    asOf: pricing.effectiveFrom,
                  }
                : null,
            },
          };
        });

      reply.header('x-request-id', requestId);
      return reply.status(200).send({
        object: 'list',
        data,
        gateway: {
          pricingVersion: ctx.pricing.version,
          pricingAgeDays: ctx.pricing.ageInDays(),
          virtualModels: [
            'gateway/auto',
            'gateway/cheapest',
            'gateway/fastest',
            'gateway/most-reliable',
          ],
        },
      });
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });

  /** Current limit state, so a client can pace itself without probing for 429s. */
  app.get('/v1/limits', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await auth(request);
      requireScopes(identity, 'usage.read');
      // Report the limits that actually apply to this project, not the
      // built-in defaults: a client pacing itself against the wrong numbers is
      // worse than one that has none.
      const tenant = await loadTenant(ctx, identity);
      const state = await ctx.rateLimiter.peek(rulesFromPolicy(tenant.policy.rateLimits), {
        organizationId: identity.organizationId,
        projectId: identity.projectId,
        apiKeyId: identity.apiKeyId,
      });
      reply.header('x-request-id', requestId);
      return reply.status(200).send({
        object: 'list',
        data: state.map((s) => ({
          rule: s.rule.id,
          subject: s.rule.subject,
          unit: s.rule.unit,
          window: s.rule.window,
          limit: s.limit,
          used: s.used,
          remaining: s.remaining,
          resetAt: s.resetAt,
        })),
      });
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });
}

/**
 * An AbortSignal that fires when the client goes away.
 *
 * Without this, a client that hangs up leaves the gateway paying for tokens
 * nobody will read.
 */
export function abortSignalFor(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once('close', () => {
    // `close` also fires on a normal completed response; only treat it as a
    // disconnect when the response was not finished.
    if (!request.raw.readableEnded || !(request.raw as { complete?: boolean }).complete) abort();
  });
  request.raw.once('aborted', abort);
  request.raw.once('error', abort);
  return controller.signal;
}

/** Bridge an async generator of SSE frames onto a Node readable stream. */
export function toNodeStream(frames: AsyncIterable<string>): Readable {
  return Readable.from(frames, { objectMode: false });
}
