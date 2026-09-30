import {
  chatRequestSchema,
  GatewayError,
  newRequestId,
  parseOrThrow,
  type ChatRequest,
} from '@ai-gateway/core';
import { permittedModels } from '@ai-gateway/policies';
import { projectCost } from '@ai-gateway/pricing';
import {
  isRoutingStrategy,
  planRoute,
  requiredCapabilities,
  resolveCandidates,
  type RoutingStrategy,
} from '@ai-gateway/router';
import { estimatePromptTokens } from '@ai-gateway/core';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireScopes } from '../auth.js';
import { targetKey, type GatewayContext } from '../context.js';
import { sendError } from '../errors.js';
import { ChatPipeline } from '../pipeline/chat.js';
import { loadTenant } from '../pipeline/tenant.js';
import { abortSignalFor } from './v1.js';

/**
 * Routing playground and failover testing.
 *
 * Two things this must get right:
 *  - a routing *test* sends no upstream request and spends no money, so an
 *    operator can reason about a policy change safely
 *  - anything that does send a real request is tagged as test traffic and
 *    excluded from production analytics
 */
export async function registerPlaygroundRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
): Promise<void> {
  const pipeline = new ChatPipeline(ctx);

  const identify = async (headers: Record<string, unknown>) =>
    authenticate(
      { store: ctx.store, pepper: ctx.config.apiKeyPepper, cache: ctx.authCache },
      (headers['authorization'] as string | undefined) ??
        (headers['x-api-key'] as string | undefined),
    );

  const routeTestInput = z.object({
    model: z.string().min(1),
    /** Optional prompt, used only to size the cost projection. */
    prompt: z.string().max(100_000).optional(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
    strategy: z.string().optional(),
    candidates: z.array(z.string()).max(20).optional(),
    maxTokens: z.number().int().min(1).max(200_000).default(1024),
    stream: z.boolean().default(false),
    requireTools: z.boolean().default(false),
    requireVision: z.boolean().default(false),
  });

  /**
   * Dry-run the router.
   *
   * Returns the chain that would be attempted, the score and reason for each
   * candidate, and every candidate that would be excluded and why. No provider
   * is contacted.
   */
  app.post('/api/v1/playground/route-test', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await identify(request.headers as Record<string, unknown>);
      requireScopes(identity, 'models.read');

      const input = routeTestInput.parse(request.body);
      const tenant = await loadTenant(ctx, identity);

      const messages = input.messages?.length
        ? input.messages.map((m: { role: string; content: string }) => ({
            role: m.role as 'user',
            content: m.content,
          }))
        : [{ role: 'user' as const, content: input.prompt ?? 'Explain this SQL query.' }];

      const probe: ChatRequest = {
        model: input.model,
        messages,
        max_tokens: input.maxTokens,
        stream: input.stream,
        ...(input.requireTools
          ? { tools: [{ type: 'function' as const, function: { name: 'probe' } }] }
          : {}),
      };

      const registeredIds = tenant.registeredModels.map((m) => m.id);
      const permitted = permittedModels({
        auth: identity,
        organizationAllowedModels: tenant.organization.allowedModels,
        organizationDeniedModels: tenant.organization.deniedModels,
        projectAllowedModels: tenant.project.allowedModels,
        projectDeniedModels: tenant.project.deniedModels,
        policy: tenant.policy,
        registeredModels: registeredIds,
      });

      const candidates = permitted
        .map((id) => ctx.providers.getModel(id))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((model) => ({ providerId: model.providerId, modelId: model.id, model }));

      const resolved = resolveCandidates({
        requestedModel: input.model,
        allowed: candidates,
        explicitModels: input.candidates,
        policyModels: tenant.policy.routing.models.map((m) =>
          typeof m === 'string' ? m : m.model,
        ),
      });

      const strategy: RoutingStrategy = input.strategy
        ? isRoutingStrategy(input.strategy)
          ? input.strategy
          : (() => {
              throw new GatewayError(
                'invalid_request',
                `Unknown routing strategy "${input.strategy}".`,
              );
            })()
        : (resolved.impliedStrategy ?? (tenant.policy.routing.strategy as RoutingStrategy));

      const estimatedInput = estimatePromptTokens(messages);
      const needed = requiredCapabilities({
        ...probe,
        ...(input.requireVision
          ? {
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'image_url', image_url: { url: 'https://example/x.png' } }],
                },
              ],
            }
          : {}),
      });

      const plan = planRoute({
        request: probe,
        candidates: resolved.candidates,
        strategy,
        requiredCapabilities: needed,
        signals: (target) => {
          const key = targetKey(target.providerId, target.modelId);
          const stats = ctx.health.stats(key);
          const pricing = ctx.pricing.lookup(target.modelId);
          return {
            health: stats,
            healthState: stats.state,
            circuit: ctx.circuits.get(key).currentState,
            projectedCost: pricing
              ? projectCost(estimatedInput, input.maxTokens, pricing.pricing)
              : undefined,
            p95LatencyMs: stats.total > 0 ? stats.p95LatencyMs : undefined,
            successRate: stats.total > 0 ? stats.successRate : undefined,
          };
        },
        maxChainLength: tenant.policy.fallback.maxTargets,
        fallbackEnabled: tenant.policy.fallback.enabled,
        // A dry run must not mutate the round-robin cursor that live traffic uses.
        roundRobinCursor: 0,
      });

      reply.header('x-request-id', requestId);
      return reply.send({
        simulated: true,
        note: 'No provider was contacted and nothing was billed. This is the plan the router would produce right now.',
        requestId,
        strategy: plan.strategy,
        requiredCapabilities: needed,
        estimatedInputTokens: estimatedInput,
        estimateIsApproximate: true,
        selected: plan.chain[0]
          ? {
              provider: plan.chain[0].target.providerId,
              model: plan.chain[0].target.modelId,
              score: Number(plan.chain[0].score.toFixed(6)),
              reasons: plan.chain[0].reasons,
            }
          : null,
        chain: plan.chain.map((entry, index) => ({
          position: index,
          role: index === 0 ? 'primary' : 'fallback',
          provider: entry.target.providerId,
          model: entry.target.modelId,
          score: Number(entry.score.toFixed(6)),
          reasons: entry.reasons,
          signals: {
            healthState: entry.signals.healthState,
            circuit: entry.signals.circuit,
            measuredRequests: entry.signals.health?.total ?? 0,
            successRate: entry.signals.successRate ?? null,
            p95LatencyMs: entry.signals.p95LatencyMs ?? null,
            projectedCost: entry.signals.projectedCost ?? null,
          },
        })),
        rejected: plan.rejected,
        planReasons: plan.reasons,
        policy: { name: tenant.policy.name, version: tenant.policyVersion ?? null },
      });
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });

  /**
   * Run a real request through the pipeline, flagged as test traffic.
   *
   * This is what the dashboard playground calls. It costs money and is visible
   * in the request log, but `isTest` keeps it out of production analytics.
   */
  app.post('/api/v1/playground/run', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await identify(request.headers as Record<string, unknown>);
      requireScopes(identity, 'inference.create');

      const parsed = parseOrThrow(
        chatRequestSchema,
        request.body,
        'playground request',
      ) as ChatRequest;
      const result = await pipeline.run({
        auth: identity,
        // Force the test flag; a playground call must never be counted as production.
        request: {
          ...parsed,
          gateway: {
            ...parsed.gateway,
            test: true,
            tags: [...(parsed.gateway?.tags ?? []), 'playground'],
          },
        },
        requestId,
        signal: abortSignalFor(request),
        userAgent: request.headers['user-agent'],
      });

      if (result.kind === 'json') {
        for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
        return reply.send({
          ...result.body,
          gatewayNote: 'Recorded as test traffic; excluded from production analytics.',
        });
      }
      for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
      const { toNodeStream } = await import('./v1.js');
      return reply.send(toNodeStream(result.frames));
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });

  const simulateInput = z.object({
    model: z.string().min(1),
    failureMode: z.enum([
      'none',
      'rate_limit',
      'server_error',
      'timeout',
      'overloaded',
      'auth',
      'invalid_request',
      'mid_stream_error',
    ]),
    failFirstN: z.number().int().min(0).max(100).optional(),
    latencyMs: z.number().int().min(0).max(60_000).optional(),
  });

  /**
   * Inject a failure into the synthetic mock provider so fallback, retry and
   * circuit-breaker behaviour can be exercised end to end.
   *
   * Only ever touches the mock provider: there is no mechanism here to make a
   * real provider misbehave, and attempting it returns 400.
   */
  app.post('/api/v1/playground/simulate-failure', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await identify(request.headers as Record<string, unknown>);
      requireScopes(identity, 'admin');

      if (!ctx.mockProvider) {
        throw new GatewayError(
          'invalid_request',
          'Failure simulation requires the synthetic mock provider, which is not registered. Set ENABLE_MOCK_PROVIDER=true.',
        );
      }

      const input = simulateInput.parse(request.body);
      const model = ctx.providers.getModel(input.model);
      if (!model)
        throw new GatewayError('model_not_found', `Model "${input.model}" is not registered.`);
      if (model.providerId !== ctx.mockProvider.id) {
        throw new GatewayError(
          'invalid_request',
          `Failure simulation is only available for models served by the mock provider. "${input.model}" belongs to "${model.providerId}".`,
        );
      }

      ctx.mockProvider.setBehavior(model.providerModelId, {
        failureMode: input.failureMode,
        ...(input.failFirstN !== undefined ? { failFirstN: input.failFirstN } : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      });

      reply.header('x-request-id', requestId);
      return reply.send({
        applied: true,
        model: input.model,
        provider: ctx.mockProvider.id,
        behavior: input,
        note: 'Applies only to the synthetic mock provider. Real providers cannot be made to fail from this endpoint.',
      });
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });

  /** Reset the circuit breakers, e.g. after fixing a credential. */
  app.post('/api/v1/playground/reset-circuits', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await identify(request.headers as Record<string, unknown>);
      requireScopes(identity, 'admin');
      const before = ctx.circuits.snapshots();
      ctx.circuits.resetAll();
      return reply.send({
        reset: before.length,
        states: before.map((s) => ({ target: s.key, wasState: s.state })),
      });
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });

  const replayInput = z.object({
    /** Required, explicit acknowledgement. Replay is never implicit. */
    confirm: z.literal(true),
    model: z.string().optional(),
    strategy: z.string().optional(),
  });

  /**
   * Replay a historical request.
   *
   * Hard requirements from the spec, enforced here: replay only ever happens on
   * an explicit, confirmed action; it needs the stored body, which only exists
   * if the org's retention policy kept one; and the replay is recorded as test
   * traffic so it cannot distort production analytics or double-count spend.
   */
  app.post('/api/v1/requests/:id/replay', async (request, reply) => {
    const requestId = newRequestId();
    try {
      const identity = await identify(request.headers as Record<string, unknown>);
      requireScopes(identity, 'logs.read', 'inference.create');

      const { id } = request.params as { id: string };
      const input = replayInput.parse(request.body ?? {});
      void input;

      const original = await ctx.store.getRequest(identity.organizationId, id);
      if (!original) throw new GatewayError('model_not_found', `Request "${id}" not found.`);

      const body = await ctx.store.getPromptBody(identity.organizationId, id);
      if (!body?.request) {
        const organization = await ctx.store.getOrganization(identity.organizationId);
        throw new GatewayError(
          'invalid_request',
          `No stored request body for "${id}", so it cannot be replayed. The organization's prompt retention mode is "${organization?.privacy.mode ?? 'unknown'}"; replay requires "redacted" or "full".`,
          { details: { retentionMode: organization?.privacy.mode } },
        );
      }

      const stored = parseOrThrow(
        chatRequestSchema,
        body.request,
        'stored request body',
      ) as ChatRequest;
      const result = await pipeline.run({
        auth: identity,
        request: {
          ...stored,
          ...(input.model ? { model: input.model } : {}),
          gateway: {
            ...stored.gateway,
            ...(input.strategy ? { strategy: input.strategy } : {}),
            test: true,
            tags: [...(stored.gateway?.tags ?? []), 'replay', `replay-of:${id}`],
          },
        },
        requestId,
        signal: abortSignalFor(request),
        userAgent: request.headers['user-agent'],
      });

      if (result.kind === 'json') {
        for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
        return reply.send({
          replayOf: id,
          original: {
            provider: original.resolvedProviderId,
            model: original.resolvedModelId,
            status: original.status,
            latencyMs: original.latencyMs,
            estimatedCost: original.estimatedCost,
          },
          replay: result.body,
          note: 'The replay was recorded as test traffic and is excluded from production analytics.',
        });
      }
      const { toNodeStream } = await import('./v1.js');
      for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
      return reply.send(toNodeStream(result.frames));
    } catch (err) {
      return sendError(reply, err, requestId);
    }
  });
}
