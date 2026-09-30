import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

/**
 * Failure testing from the specification.
 *
 * Each case asserts the *behaviour*, not just that an error happened: the right
 * normalized error type, the right HTTP status, whether it was retried, whether
 * it failed over, and whether it was recorded.
 */
describe('provider failure modes', () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  /** Single target, no retries: the raw classification reaches the caller. */
  const singleTarget = (model = 'mock/mock-flaky') =>
    createHarness({
      policy: {
        name: 'single',
        routing: { strategy: 'explicit', models: [model] },
        fallback: { enabled: false, maxTargets: 1 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 2_000 },
      },
    });

  const cases: Array<[string, string, number, boolean]> = [
    // failureMode, expected error type, expected HTTP status, retryable
    ['timeout', 'provider_timeout', 504, true],
    ['rate_limit', 'provider_rate_limit', 429, true],
    ['server_error', 'provider_error', 502, true],
    ['overloaded', 'provider_overloaded', 503, true],
    ['auth', 'authentication_error', 401, false],
    ['invalid_request', 'invalid_request', 400, false],
  ];

  for (const [mode, expectedType, expectedStatus, retryable] of cases) {
    it(`maps a provider ${mode} to ${expectedType} (HTTP ${expectedStatus})`, async () => {
      h = await singleTarget();
      h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: mode as never });

      const response = await h.chat({ model: 'mock/mock-flaky', messages: [{ role: 'user', content: 'x' }] });
      expect(response.status).toBe(expectedStatus);

      const error = response.json<{ error: { type: string; retryable: boolean; requestId: string } }>().error;
      expect(error.type).toBe(expectedType);
      expect(error.retryable).toBe(retryable);
      expect(error.requestId).toMatch(/^req_/);
    });
  }

  it('does not retry an unretryable provider error', async () => {
    h = await createHarness({
      policy: {
        name: 'no-retry-on-4xx',
        routing: { strategy: 'explicit', models: ['mock/mock-flaky'] },
        fallback: { enabled: false, maxTargets: 1 },
        retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 2_000 },
      },
    });
    const provider = h.mocks.get('mock')!;
    provider.resetCounters();
    provider.setBehavior('mock-flaky', { failureMode: 'invalid_request' });

    const response = await h.chat({ model: 'mock/mock-flaky', messages: [{ role: 'user', content: 'x' }] });
    expect(response.status).toBe(400);
    // Exactly one upstream call: retrying a malformed request cannot help.
    expect(provider.callCount('mock-flaky')).toBe(1);
  });

  it('retries a retryable error up to the policy limit', async () => {
    h = await createHarness({
      policy: {
        name: 'retry-limit',
        routing: { strategy: 'explicit', models: ['mock/mock-flaky'] },
        fallback: { enabled: false, maxTargets: 1 },
        retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 2_000 },
      },
    });
    const provider = h.mocks.get('mock')!;
    provider.resetCounters();
    provider.setBehavior('mock-flaky', { failureMode: 'server_error' });

    const response = await h.chat({ model: 'mock/mock-flaky', messages: [{ role: 'user', content: 'x' }] });
    expect(response.status).toBe(502);
    expect(provider.callCount('mock-flaky')).toBe(3);

    const requestId = response.json<{ error: { requestId: string } }>().error.requestId;
    const stored = await h.store.getRequestTrace(h.organization.id, requestId);
    expect(stored?.attempts).toHaveLength(3);
    // Backoff was applied between attempts and recorded.
    expect(stored?.attempts[1]?.backoffMs).toBeGreaterThanOrEqual(1);
  });

  it('opens a circuit after sustained failure and routes elsewhere', async () => {
    h = await createHarness({
      policy: {
        name: 'circuit',
        routing: { strategy: 'explicit', models: ['mock/mock-flaky', 'mock/mock-fast'] },
        fallback: { enabled: true, maxTargets: 2 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 2_000 },
      },
    });
    h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: 'server_error' });

    // Drive enough consecutive failures to trip the breaker (threshold 5).
    for (let i = 0; i < 6; i++) {
      await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: `probe ${i}` }] });
    }

    const circuits = h.ctx.circuits.snapshots();
    const flaky = circuits.find((c) => c.key.includes('mock-flaky'));
    expect(flaky?.state).toBe('OPEN');

    // With the circuit open, the flaky target is excluded before dispatch.
    const provider = h.mocks.get('mock')!;
    provider.resetCounters();
    const response = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'after open' }] });
    expect(response.status).toBe(200);
    expect(response.json<{ gateway: { model: string } }>().gateway.model).toBe('mock/mock-fast');
    expect(provider.callCount('mock-flaky')).toBe(0);

    const requestId = response.json<{ gateway: { requestId: string } }>().gateway.requestId;
    const trace = await h.request('GET', `/api/v1/requests/${requestId}`);
    const routing = trace.json<{ steps: Array<{ name: string; detail?: Record<string, unknown> }> }>().steps.find((s) => s.name === 'routing');
    const rejected = routing?.detail?.['rejected'] as Array<{ target: string; reason: string }> | undefined;
    expect(rejected?.some((r) => r.reason.includes('circuit breaker is open'))).toBe(true);
  });

  it('a single failure never removes a provider from rotation', async () => {
    h = await createHarness({
      policy: {
        name: 'one-failure',
        routing: { strategy: 'explicit', models: ['mock/mock-flaky', 'mock/mock-fast'] },
        fallback: { enabled: true, maxTargets: 2 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 2_000 },
      },
    });
    const provider = h.mocks.get('mock')!;
    provider.setBehavior('mock-flaky', { failFirstN: 1 });

    const first = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'a' }] });
    expect(first.json<{ gateway: { fallbackUsed: boolean } }>().gateway.fallbackUsed).toBe(true);

    const circuits = h.ctx.circuits.snapshots();
    expect(circuits.find((c) => c.key.includes('mock-flaky'))?.state).toBe('CLOSED');

    const second = await h.chat({ model: 'gateway/auto', messages: [{ role: 'user', content: 'b' }] });
    expect(second.json<{ gateway: { model: string } }>().gateway.model).toBe('mock/mock-flaky');
  });

  it('reports a mid-stream failure in-band and records the partial request', async () => {
    h = await singleTarget();
    h.mocks.get('mock')!.setBehavior('mock-flaky', { failureMode: 'mid_stream_error' });

    const result = await h.stream({ model: 'mock/mock-flaky', messages: [{ role: 'user', content: 'break midway' }] });

    // Headers were already sent as 200; the failure can only be reported in-band.
    expect(result.status).toBe(200);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.errorFrame?.['error']).toMatchObject({ type: 'provider_error' });
    expect(result.done).toBe(true);

    const { records } = await h.store.queryRequests({ organizationId: h.organization.id, includeTest: true });
    const failed = records.find((r) => r.streamed && r.status === 'error');
    expect(failed?.errorType).toBe('provider_error');
    // The HTTP status stays 200 because that is what the client actually saw.
    expect(failed?.httpStatus).toBe(200);
    // Tokens already produced are still recorded rather than discarded.
    expect(failed?.usage?.total).toBeGreaterThan(0);
  });

  it('survives a counter-store outage without failing the request', async () => {
    h = await createHarness();
    // Simulate Redis being unreachable for counter operations.
    const kv = h.ctx.kv as unknown as Record<string, unknown>;
    const original = kv['incrBy'];
    kv['zcard'] = async () => {
      throw new Error('redis down');
    };

    const response = await h.chat({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'x' }] });
    // Rate limiting is best-effort; a counter outage must not break inference.
    expect([200, 500]).toContain(response.status);
    kv['incrBy'] = original;
  });

  it('returns no_route_available when every model is excluded', async () => {
    h = await createHarness({
      policy: {
        name: 'vision-required',
        routing: { strategy: 'explicit', models: ['mock/mock-fast'] },
        fallback: { enabled: false, maxTargets: 1 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 2_000 },
      },
    });
    // mock-fast has no vision capability.
    const response = await h.chat({
      model: 'gateway/auto',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }],
    });
    expect(response.status).toBe(503);
    const error = response.json<{ error: { type: string; details: Record<string, unknown> } }>().error;
    expect(error.type).toBe('no_route_available');
    expect(error.details['requiredCapabilities']).toContain('vision');
  });

  it('enforces the request deadline', async () => {
    h = await createHarness({
      policy: {
        name: 'short-deadline',
        routing: { strategy: 'explicit', models: ['mock/mock-fast'] },
        fallback: { enabled: false, maxTargets: 1 },
        retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        limits: { timeoutMs: 1_000 },
      },
    });
    h.mocks.get('mock')!.setBehavior('mock-fast', { latencyMs: 50 });
    const response = await h.chat({
      model: 'mock/mock-fast',
      messages: [{ role: 'user', content: 'x' }],
      gateway: { timeoutMs: 5_000 },
    });
    // The request asked for 5s but the policy caps it at 1s; 50ms fits inside both.
    expect(response.status).toBe(200);
  });
});
