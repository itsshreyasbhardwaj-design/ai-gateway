import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

/**
 * The complete product demonstration from the specification, exercised against
 * a real gateway: policy evaluation, cache lookup, routing, streaming, usage
 * and cost recording, trace storage, then an induced provider failure that
 * fallback recovers from, visible in both the trace and the analytics.
 */
describe('end-to-end gateway flow', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ captureWebhooks: true });
  });

  afterAll(async () => {
    await h.close();
  });

  it('serves an OpenAI-compatible completion', async () => {
    const response = await h.chat({
      model: 'gateway/auto',
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
    });

    expect(response.status).toBe(200);
    const body = response.json<{
      id: string;
      object: string;
      model: string;
      choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
      usage: { input: number; output: number; total: number; source: string };
      gateway: Record<string, unknown>;
    }>();

    // Shape a client written against OpenAI would expect.
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0]?.message.role).toBe('assistant');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(typeof body.choices[0]?.message.content).toBe('string');

    // Everything the gateway adds is namespaced, so no client parser breaks.
    expect(body.gateway.provider).toBe('mock');
    expect(body.gateway.cache).toBe('miss');
    expect(body.gateway.attempts).toBe(1);
    expect(body.usage.source).toBe('provider_reported');
  });

  it('explains why it routed where it did', async () => {
    const response = await h.chat({
      model: 'gateway/auto',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const receipt = response.json<{ gateway: { reasons: string[]; strategy: string; model: string } }>().gateway;

    expect(receipt.reasons.length).toBeGreaterThan(1);
    expect(receipt.reasons.join(' ')).toContain(`strategy: ${receipt.strategy}`);
    expect(receipt.reasons.join(' ')).toMatch(/candidates eligible/);
  });

  it('exposes routing metadata in response headers', async () => {
    const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.headers['x-request-id']).toMatch(/^req_/);
    expect(response.headers['x-gateway-provider']).toBe('mock');
    expect(response.headers['x-gateway-model']).toBe('mock/mock-fast');
    expect(response.headers['x-gateway-usage-source']).toBe('provider_reported');
    expect(Number(response.headers['x-gateway-estimated-cost'])).toBeGreaterThan(0);
  });

  it('reports rate-limit state on every response', async () => {
    const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'hi' }] });
    expect(Number(response.headers['x-ratelimit-limit-requests'])).toBeGreaterThan(0);
    expect(Number(response.headers['x-ratelimit-remaining-requests'])).toBeLessThan(
      Number(response.headers['x-ratelimit-limit-requests']),
    );
    expect(Number(response.headers['x-ratelimit-reset-requests'])).toBeGreaterThan(0);
  });

  it('streams server-sent events with a terminal routing receipt', async () => {
    const result = await h.stream({
      model: 'mock/mock-fast',
      messages: [{ role: 'user', content: 'stream this please' }],
    });

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    expect(result.headers['cache-control']).toContain('no-cache');
    expect(result.done).toBe(true);

    // More than a couple of chunks, i.e. actually incremental.
    expect(result.chunks.length).toBeGreaterThan(3);
    expect(result.text.length).toBeGreaterThan(20);

    const first = result.chunks[0] as { choices: Array<{ delta: { role?: string } }> };
    expect(first.choices[0]?.delta.role).toBe('assistant');

    const final = result.chunks.at(-1) as { choices: Array<{ finish_reason: string }>; usage?: { total: number } };
    expect(final.choices[0]?.finish_reason).toBe('stop');
    expect(final.usage?.total).toBeGreaterThan(0);

    expect(result.receipt?.provider).toBe('mock');
    expect(result.receipt?.cache).toBe('miss');
  });

  it('records a full trace for every request', async () => {
    const response = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'trace me' }] });
    const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;

    const trace = await h.request('GET', `/api/v1/requests/${requestId}`);
    expect(trace.status).toBe(200);
    const body = trace.json<{
      request: Record<string, unknown>;
      steps: Array<{ name: string; status: string; durationMs: number }>;
      attempts: Array<{ providerId: string; status: string }>;
      privacy: { bodyStored: boolean };
    }>();

    const stepNames = body.steps.map((s) => s.name);
    // Every gate that could change the outcome appears on the timeline.
    expect(stepNames).toContain('request_received');
    expect(stepNames).toContain('authentication');
    expect(stepNames).toContain('rate_limit');
    expect(stepNames).toContain('policy_evaluation');
    expect(stepNames).toContain('budget_check');
    expect(stepNames).toContain('cache_lookup');
    expect(stepNames).toContain('routing');
    expect(stepNames).toContain('provider_request');
    expect(stepNames).toContain('usage_extraction');
    expect(stepNames).toContain('response_sent');

    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]?.status).toBe('success');
    // Default privacy mode is metadata_only, so no body is retained.
    expect(body.privacy.bodyStored).toBe(false);
  });

  it('records usage and cost with the pricing version used', async () => {
    const response = await h.chat({ model: 'mock/mock-smart', messages: [{ role: 'user', content: 'price me' }] });
    const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;

    const stored = await h.store.getRequest(h.organization.id, requestId);
    expect(stored?.estimatedCost).toBeGreaterThan(0);
    expect(stored?.currency).toBe('USD');
    expect(stored?.pricingVersion).toBe('seed-unverified-v1');
    expect(stored?.usage?.source).toBe('provider_reported');
  });

  it('surfaces usage analytics from real request rows', async () => {
    const before = await h.request('GET', '/api/v1/usage?range=24h');
    const beforeCount = before.json<{ summary: { totalRequests: number } }>().summary.totalRequests;

    await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'count me' }] });

    const after = await h.request('GET', '/api/v1/usage?range=24h');
    const body = after.json<{
      summary: { totalRequests: number; totalTokens: number; estimatedCost: number; successRate: number };
      series: Array<{ bucket: string; requests: number }>;
      breakdown: { provider: Array<{ key: string; requests: number }> };
      disclosure: { pricingVersion: string; note: string };
    }>();

    expect(body.summary.totalRequests).toBe(beforeCount + 1);
    expect(body.summary.totalTokens).toBeGreaterThan(0);
    expect(body.summary.estimatedCost).toBeGreaterThan(0);
    expect(body.breakdown.provider[0]?.key).toBe('mock');
    expect(body.series.length).toBeGreaterThan(10);
    // Cost figures always ship with a statement of where they came from.
    expect(body.disclosure.note).toContain('configured price table');
  });

  it('lists only models the key may use, with capability and pricing metadata', async () => {
    const response = await h.request('GET', '/v1/models');
    const body = response.json<{
      data: Array<{ id: string; gateway: { capabilities: string[]; pricing: { version: string } | null } }>;
      gateway: { virtualModels: string[]; pricingVersion: string };
    }>();

    expect(body.data.map((m) => m.id)).toEqual(
      expect.arrayContaining(['mock/mock-fast', 'mock/mock-smart', 'mock/mock-embed']),
    );
    expect(body.data[0]?.gateway.capabilities.length).toBeGreaterThan(0);
    expect(body.gateway.virtualModels).toContain('gateway/auto');
  });

  it('serves embeddings through the same gates', async () => {
    const response = await h.request('POST', '/v1/embeddings', {
      model: 'mock/mock-embed',
      input: ['first document', 'second document'],
    });

    expect(response.status).toBe(200);
    const body = response.json<{
      object: string;
      data: Array<{ index: number; embedding: number[] }>;
      usage: { source: string };
      gateway: { provider: string };
    }>();
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.embedding.length).toBeGreaterThan(0);
    expect(body.gateway.provider).toBe('mock');
  });

  it('refuses a chat request to an embeddings-only model', async () => {
    const response = await h.chat({ model: 'mock/mock-embed', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const error = response.json<{ error: { type: string } }>().error;
    expect(['no_route_available', 'capability_unsupported']).toContain(error.type);
  });

  it('reports readiness and metrics', async () => {
    const ready = await h.request('GET', '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.json<{ status: string }>().status).toBe('ready');

    const metrics = await h.request('GET', '/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.raw).toContain('aigw_requests_total');
    expect(metrics.raw).toContain('aigw_request_duration_ms_bucket');
    expect(metrics.raw).toContain('aigw_provider_health');
  });
});

describe('fallback under provider failure', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({
      policy: {
        name: 'fallback-e2e',
        routing: { strategy: 'explicit', models: ['mock/mock-flaky', 'mock/mock-fast'] },
        fallback: { enabled: true, maxTargets: 2 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 5_000 },
      },
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('fails over to the next target and says so', async () => {
    // Induce a failure on the primary only.
    h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: 'server_error' });

    const response = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'survive this' }] });
    expect(response.status).toBe(200);

    const receipt = response.json<{ gateway: { model: string; fallbackUsed: boolean; attempts: number; requestId: string } }>().gateway;
    expect(receipt.model).toBe('mock/mock-fast');
    expect(receipt.fallbackUsed).toBe(true);
    expect(receipt.attempts).toBe(2);

    // The failure is visible in the trace, not silently swallowed.
    const trace = await h.request('GET', `/api/v1/requests/${receipt.requestId}`);
    const attempts = trace.json<{ attempts: Array<{ modelId: string; status: string; errorType?: string }> }>().attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ modelId: 'mock/mock-flaky', status: 'error', errorType: 'provider_error' });
    expect(attempts[1]).toMatchObject({ modelId: 'mock/mock-fast', status: 'success' });
  });

  it('retries the same target before failing over when retries remain', async () => {
    const retryHarness = await createHarness({
      policy: {
        name: 'retry-e2e',
        routing: { strategy: 'explicit', models: ['mock/mock-flaky', 'mock/mock-fast'] },
        fallback: { enabled: true, maxTargets: 2 },
        retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 5_000 },
      },
    });
    try {
      // Fails twice, then recovers - so the primary should still serve it.
      retryHarness.mocks.get('mock')!.setBehavior('mock-flaky', { failFirstN: 2 });

      const response = await retryHarness.chat({
        model: 'gateway/auto',
        messages: [{ role: 'user', content: 'retry me' }],
      });
      expect(response.status).toBe(200);
      const receipt = response.json<{ gateway: { model: string; attempts: number; fallbackUsed: boolean } }>().gateway;
      expect(receipt.model).toBe('mock/mock-flaky');
      expect(receipt.attempts).toBe(3);
      expect(receipt.fallbackUsed).toBe(false);
    } finally {
      await retryHarness.close();
    }
  });

  it('records the fallback in analytics', async () => {
    h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: 'overloaded' });
    await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'analytics' }] });

    const usage = await h.request('GET', '/api/v1/usage?range=24h');
    const summary = usage.json<{ summary: { fallbackRate: number } }>().summary;
    expect(summary.fallbackRate).toBeGreaterThan(0);
  });

  it('reports fallback_exhausted when every target fails', async () => {
    h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: 'server_error' });
    h.mocks.get('mock')!.setBehavior('mock-fast', { failureMode: 'server_error' });

    const response = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'nothing works' }] });
    expect(response.status).toBe(502);
    const error = response.json<{ error: { type: string; requestId: string; details: Record<string, unknown> } }>().error;
    expect(error.type).toBe('fallback_exhausted');
    expect(error.requestId).toMatch(/^req_/);
    expect(error.details['chain']).toEqual(['mock/mock-flaky', 'mock/mock-fast']);

    // Reset so later tests are unaffected.
    h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: 'none', failFirstN: 0 });
    h.mocks.get('mock')!.setBehavior('mock-fast', { failureMode: 'none', failFirstN: 0 });
  });
});
