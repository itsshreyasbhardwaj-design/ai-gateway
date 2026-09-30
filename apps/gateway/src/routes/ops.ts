import { isUnverified } from '@ai-gateway/pricing';
import type { FastifyInstance } from 'fastify';
import type { GatewayContext } from '../context.js';

/**
 * Operational endpoints.
 *
 * Deliberately unauthenticated, and deliberately free of tenant data: a load
 * balancer needs `/healthz` before any credential exists, and an operator needs
 * `/metrics` scrapeable. Nothing here reveals which organizations exist or what
 * they sent.
 */
export async function registerOpsRoutes(app: FastifyInstance, ctx: GatewayContext): Promise<void> {
  const startedAt = Date.now();

  /** Liveness: is the process up? */
  app.get('/healthz', async () => ({ status: 'ok', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) }));

  /**
   * Readiness: can this replica actually serve a request?
   *
   * A gateway with no providers registered is up but useless, so it reports
   * degraded rather than ready - that distinction is what stops a deploy from
   * rolling out a replica that will 503 every request.
   */
  app.get('/readyz', async (_request, reply) => {
    const [storeOk, kvOk] = await Promise.all([ctx.store.healthCheck(), ctx.kv.ping()]);
    const providers = ctx.providers.size;
    const checks = {
      store: { ok: storeOk, kind: ctx.store.kind },
      counters: { ok: kvOk, durable: !!ctx.config.redisUrl },
      providers: { ok: providers > 0, count: providers },
    };
    const ready = storeOk && providers > 0;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'degraded',
      checks,
      ...(providers === 0 ? { reason: 'no providers registered' } : {}),
    });
  });

  /** Prometheus scrape target. */
  app.get('/metrics', async (_request, reply) => {
    for (const provider of ctx.providers.listProviderIds()) {
      const stats = ctx.health.stats(provider);
      ctx.metrics.setGauge('aigw_provider_health', healthGauge(stats.state), { provider });
      ctx.metrics.setGauge('aigw_provider_success_rate', stats.successRate, { provider });
      ctx.metrics.setGauge('aigw_provider_p95_latency_ms', stats.p95LatencyMs, { provider });
    }
    for (const snapshot of ctx.circuits.snapshots()) {
      ctx.metrics.setGauge('aigw_circuit_state', circuitGauge(snapshot.state), { target: snapshot.key });
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(ctx.metrics.render());
  });

  /**
   * Self-description. Useful for a client deciding what the gateway supports,
   * and for an operator checking what is actually configured.
   */
  app.get('/', async () => ({
    service: 'ai-gateway',
    version: '0.1.0',
    endpoints: {
      chatCompletions: 'POST /v1/chat/completions',
      responses: 'POST /v1/responses',
      embeddings: 'POST /v1/embeddings',
      models: 'GET /v1/models',
      limits: 'GET /v1/limits',
      admin: '/api/v1/*',
      health: 'GET /healthz',
      ready: 'GET /readyz',
      metrics: 'GET /metrics',
    },
    capabilities: {
      streaming: true,
      tools: true,
      embeddings: ctx.providers.listProviders().some((p) => typeof p.embed === 'function'),
      semanticCache: !!ctx.semanticCache,
      fallback: true,
      budgets: true,
    },
    providers: ctx.providers.listProviderIds(),
    models: ctx.providers.listModels().length,
    pricing: {
      version: ctx.pricing.version,
      ageDays: ctx.pricing.ageInDays(),
      // Stated on every response so a cost figure is never mistaken for a quote.
      verified: !isUnverified(ctx.pricing.version),
      note: isUnverified(ctx.pricing.version)
        ? 'Pricing is the shipped placeholder set and has not been verified against provider price lists.'
        : undefined,
    },
    store: ctx.store.kind,
    countersDurable: !!ctx.config.redisUrl,
  }));

  /** Provider health, as measured by this gateway's own traffic. */
  app.get('/health/providers', async () => ({
    object: 'list',
    data: ctx.providers.listProviderIds().map((provider) => {
      const stats = ctx.health.stats(provider);
      return {
        provider,
        state: stats.state,
        measured: {
          requests: stats.total,
          successRate: stats.successRate,
          errorRate: stats.errorRate,
          timeoutRate: stats.timeoutRate,
          rateLimitRate: stats.rateLimitRate,
          p50LatencyMs: stats.p50LatencyMs,
          p95LatencyMs: stats.p95LatencyMs,
          p99LatencyMs: stats.p99LatencyMs,
          windowMs: stats.windowMs,
        },
        circuits: ctx.circuits.snapshots().filter((c) => c.key.startsWith(`${provider}::`) || c.key === provider),
      };
    }),
    note: 'These are measurements of this gateway\'s own traffic over the health window, not vendor-published availability.',
  }));
}

function healthGauge(state: string): number {
  return state === 'healthy' ? 1 : state === 'unknown' ? 0.75 : state === 'degraded' ? 0.5 : 0;
}

function circuitGauge(state: string): number {
  return state === 'OPEN' ? 2 : state === 'HALF_OPEN' ? 1 : 0;
}
