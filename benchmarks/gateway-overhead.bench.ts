import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryKV } from '@ai-gateway/cache';
import { loadGatewayConfig } from '@ai-gateway/config';
import { MemoryStore } from '@ai-gateway/database';
import { Logger, MemorySink } from '@ai-gateway/observability';
import { createSeedPricingBook } from '@ai-gateway/pricing';
import { ProviderRegistry } from '@ai-gateway/provider-sdk';
import { MockProvider, MOCK_MODELS } from '@ai-gateway/providers';
import { parsePolicyOrThrow } from '@ai-gateway/policies';
import { generateApiKey, keyIndex, SecretBox } from '@ai-gateway/security';
import { newId, DEFAULT_PRIVACY } from '@ai-gateway/core';
import { buildApp, buildContext, WebhookDispatcher } from '@ai-gateway/gateway';
import {
  captureEnvironment, describeEnvironment, formatTable, run, type BenchmarkResult,
} from './harness.js';

/**
 * Gateway overhead benchmark.
 *
 * Measures what the gateway itself costs, using a zero-latency synthetic
 * provider so the numbers are not dominated by a model's own response time.
 * That is the point: in production, upstream latency is measured in hundreds of
 * milliseconds and the only interesting question is how much the gateway adds
 * on top.
 *
 * These are single-process, loopback, in-memory-store numbers on whatever
 * machine ran them. They are a regression signal, not a capacity plan.
 */

const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'results');

async function buildHarness(behaviour: { latencyMs: number } = { latencyMs: 0 }) {
  const config = loadGatewayConfig({
    NODE_ENV: 'test',
    ENABLE_MOCK_PROVIDER: 'true',
    ENCRYPTION_KEY: 'benchmark-encryption-key-0123456789',
    API_KEY_PEPPER: 'benchmark-pepper-0123456789',
    LOG_LEVEL: 'error',
  });

  const store = new MemoryStore(100_000);
  const kv = new MemoryKV();
  const logs = new MemorySink();
  const logger = new Logger(logs, 'error');

  const providers = new ProviderRegistry();
  const mock = new MockProvider({
    id: 'mock',
    behavior: { latencyMs: behaviour.latencyMs, chunkDelayMs: 0, reportUsage: true },
  });
  providers.register(mock, MOCK_MODELS);

  const ctx = buildContext({
    config,
    logger,
    store,
    kv,
    providers,
    pricing: createSeedPricingBook(),
    webhooks: new WebhookDispatcher({ store, secrets: new SecretBox(config.encryptionKey), logger }),
    mockProvider: mock,
  });

  const organizationId = newId('org');
  const projectId = newId('proj');
  const now = new Date().toISOString();

  await store.createOrganization({
    id: organizationId,
    name: 'Benchmark',
    slug: 'benchmark',
    createdAt: now,
    privacy: DEFAULT_PRIVACY,
    currency: 'USD',
  });

  const policyId = newId('pol');
  const policy = parsePolicyOrThrow({
    name: 'benchmark',
    routing: { strategy: 'explicit', models: ['mock/mock-fast', 'mock/mock-smart'] },
    fallback: { enabled: true, maxTargets: 2 },
    retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
    limits: { timeoutMs: 30_000 },
    // Raised so the benchmark measures the pipeline rather than the limiter.
    // The first run of this benchmark did exactly that, which is how the
    // limits came to be policy-configurable rather than hardcoded.
    rateLimits: {
      requestsPerMinutePerKey: 1_000_000,
      tokensPerMinutePerKey: 1_000_000_000,
      requestsPerHourPerOrganization: 10_000_000,
    },
  });
  await store.createPolicy(
    { id: policyId, organizationId, projectId: null, name: 'benchmark', activeVersion: 1, createdAt: now, updatedAt: now },
    { id: newId('ver'), policyId, version: 1, document: policy, checksum: 'bench', createdBy: 'bench', active: true, createdAt: now },
  );

  await store.createProject({ id: projectId, organizationId, name: 'Benchmark', slug: 'benchmark', createdAt: now, routingPolicyId: policyId });

  const key = await generateApiKey('test');
  await store.createApiKey({
    id: newId('key'),
    organizationId,
    projectId,
    name: 'benchmark',
    prefix: key.prefix,
    hash: key.hash,
    lookupIndex: keyIndex(key.plaintext, config.apiKeyPepper),
    scopes: ['models.read', 'inference.create', 'usage.read', 'logs.read', 'admin'],
    createdAt: now,
  });

  const app = await buildApp(ctx);
  await app.ready();

  return { app, ctx, apiKey: key.plaintext, mock };
}

async function main(): Promise<void> {
  const environment = captureEnvironment();

  process.stdout.write(`\nAI Gateway benchmarks\n  ${describeEnvironment(environment)}\n\n`);
  if (environment.loaded) {
    process.stdout.write(
      '  NOTE: the machine is already under load. Throughput figures below are\n' +
        '        not representative; treat only the relative overhead as meaningful.\n\n',
    );
  }

  const results: BenchmarkResult[] = [];
  const { app, ctx, apiKey } = await buildHarness();

  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const body = (n: number) =>
    JSON.stringify({ model: 'mock/mock-fast', messages: [{ role: 'user', content: `benchmark request ${n}` }] });

  // --- 1. End-to-end, serial -------------------------------------------
  results.push(
    await run(
      {
        name: 'chat (serial)',
        description: 'Full pipeline against a zero-latency synthetic provider, one request at a time.',
        warmup: 50,
        iterations: 500,
        concurrency: 1,
        notes: ['Provider latency is zero by construction, so this is close to pure gateway cost.'],
      },
      async (i) => {
        const startedAt = performance.now();
        const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: body(i) });
        const latencyMs = performance.now() - startedAt;
        const parsed = response.statusCode === 200 ? (JSON.parse(response.body) as { gateway?: { latencyMs: number } }) : undefined;
        return {
          latencyMs,
          // The gateway's own measurement of the work it did, from the receipt.
          gatewayOverheadMs: parsed?.gateway?.latencyMs,
          ok: response.statusCode === 200,
        };
      },
    ),
  );

  // --- 2. End-to-end, concurrent ---------------------------------------
  for (const concurrency of [8, 32]) {
    results.push(
      await run(
        {
          name: `chat (c=${concurrency})`,
          description: `Full pipeline at ${concurrency} concurrent in-flight requests.`,
          warmup: 50,
          iterations: 1000,
          concurrency,
        },
        async (i) => {
          const startedAt = performance.now();
          const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: body(i) });
          return { latencyMs: performance.now() - startedAt, ok: response.statusCode === 200 };
        },
      ),
    );
  }

  // --- 3. Streaming -----------------------------------------------------
  results.push(
    await run(
      {
        name: 'chat (streaming)',
        description: 'Streaming response, measured to the last frame.',
        warmup: 20,
        iterations: 200,
        concurrency: 8,
      },
      async (i) => {
        const startedAt = performance.now();
        const response = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload: JSON.stringify({
            model: 'mock/mock-fast',
            messages: [{ role: 'user', content: `stream ${i}` }],
            stream: true,
          }),
        });
        return { latencyMs: performance.now() - startedAt, ok: response.body.includes('[DONE]') };
      },
    ),
  );

  // --- 4. Routing planning in isolation --------------------------------
  results.push(
    await run(
      {
        name: 'route plan (dry-run)',
        description: 'Router planning only: capability filter, scoring, chain construction. No provider contacted.',
        warmup: 50,
        iterations: 1000,
        concurrency: 1,
        notes: ['Isolates the routing decision from authentication, policy and persistence.'],
      },
      async () => {
        const startedAt = performance.now();
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/playground/route-test',
          headers,
          payload: JSON.stringify({ model: 'gateway/auto', prompt: 'benchmark' }),
        });
        return { latencyMs: performance.now() - startedAt, ok: response.statusCode === 200 };
      },
    ),
  );

  // --- 5. Cache hit path ------------------------------------------------
  const cached = await buildHarness();
  {
    const cachedHeaders = { authorization: `Bearer ${cached.apiKey}`, 'content-type': 'application/json' };
    const cachedPolicy = parsePolicyOrThrow({
      name: 'cached',
      routing: { strategy: 'explicit', models: ['mock/mock-fast'] },
      fallback: { enabled: false, maxTargets: 1 },
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
      cache: { mode: 'exact', ttlSeconds: 600 },
      limits: { timeoutMs: 30_000 },
      rateLimits: {
        requestsPerMinutePerKey: 1_000_000,
        tokensPerMinutePerKey: 1_000_000_000,
        requestsPerHourPerOrganization: 10_000_000,
      },
    });
    const policies = await cached.ctx.store.listPolicies(
      (await cached.ctx.store.listOrganizations())[0]!.id,
    );
    const policyId = policies[0]!.id;
    await cached.ctx.store.addPolicyVersion({
      id: newId('ver'),
      policyId,
      version: 2,
      document: cachedPolicy,
      checksum: 'bench2',
      createdBy: 'bench',
      note: null,
      active: false,
      createdAt: new Date().toISOString(),
    });
    await cached.ctx.store.activatePolicyVersion(policyId, 2, new Date().toISOString());

    const payload = JSON.stringify({
      model: 'mock/mock-fast',
      messages: [{ role: 'user', content: 'a repeated question' }],
    });
    // Populate the cache before measuring hits.
    await cached.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: cachedHeaders, payload });

    results.push(
      await run(
        {
          name: 'chat (cache hit)',
          description: 'Exact-cache hit: authentication, policy and budget still run; no provider is contacted.',
          warmup: 20,
          iterations: 500,
          concurrency: 1,
          notes: ['Shows the floor the gateway can serve at when a request is answered from cache.'],
        },
        async () => {
          const startedAt = performance.now();
          const response = await cached.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: cachedHeaders, payload });
          const parsed = JSON.parse(response.body) as { gateway?: { cache: string } };
          return { latencyMs: performance.now() - startedAt, ok: parsed.gateway?.cache === 'exact_hit' };
        },
      ),
    );
  }

  // --- 6. Realistic provider latency ------------------------------------
  const slow = await buildHarness({ latencyMs: 200 });
  {
    const slowHeaders = { authorization: `Bearer ${slow.apiKey}`, 'content-type': 'application/json' };
    results.push(
      await run(
        {
          name: 'chat (200ms provider)',
          description: 'Synthetic provider delayed by 200ms, which is the regime real traffic lives in.',
          warmup: 10,
          iterations: 200,
          concurrency: 16,
          notes: ['Compare against "chat (serial)" to see the gateway share of total latency.'],
        },
        async (i) => {
          const startedAt = performance.now();
          const response = await slow.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: slowHeaders, payload: body(i) });
          return { latencyMs: performance.now() - startedAt, providerMs: 200, ok: response.statusCode === 200 };
        },
      ),
    );
  }

  process.stdout.write(`${formatTable(results)}\n\n`);

  const serial = results.find((r) => r.name === 'chat (serial)');
  const withProvider = results.find((r) => r.name === 'chat (200ms provider)');
  if (serial && withProvider) {
    const share = (serial.latency.p50 / withProvider.latency.p50) * 100;
    process.stdout.write(
      `Gateway share of total latency at a 200ms provider: ~${share.toFixed(1)}% at p50\n` +
        `  (${serial.latency.p50.toFixed(2)}ms gateway vs ${withProvider.latency.p50.toFixed(2)}ms end to end)\n\n`,
    );
  }

  process.stdout.write(
    'Caveats\n' +
      '  · In-process HTTP injection, in-memory store, in-process counters.\n' +
      '  · A synthetic provider, so no real network or model time is included.\n' +
      '  · One process on one machine. These are regression signals, not a capacity plan.\n' +
      '  · Postgres and Redis add real latency that none of these numbers reflect.\n\n',
  );

  await mkdir(RESULTS_DIR, { recursive: true });
  const outputPath = join(RESULTS_DIR, `benchmark-${environment.timestamp.replace(/[:.]/g, '-')}.json`);
  await writeFile(outputPath, `${JSON.stringify({ environment, results }, null, 2)}\n`);
  process.stdout.write(`Saved ${outputPath}\n`);

  await app.close();
  await ctx.shutdown();
  await cached.app.close();
  await cached.ctx.shutdown();
  await slow.app.close();
  await slow.ctx.shutdown();
  process.exit(0);
}

void main();
