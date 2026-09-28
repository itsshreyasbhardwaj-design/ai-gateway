import { describe, expect, it, vi } from 'vitest';
import { FakeClock, GatewayError, type ModelDescriptor } from '@ai-gateway/core';
import { TraceBuilder } from '@ai-gateway/observability';
import { executeWithFallback } from './execute.js';
import { DEFAULT_RETRY_POLICY, NO_RETRY, backoffDelay, backoffSchedule, isRetryable } from './retry.js';
import type { RoutePlan, ScoredTarget } from './types.js';

function scored(id: string): ScoredTarget {
  const [providerId = 'p', providerModelId = 'm'] = id.split('/');
  const model: ModelDescriptor = {
    id,
    providerId,
    providerModelId,
    displayName: id,
    contextWindow: 1000,
    capabilities: ['chat'],
    status: 'available',
  };
  return {
    target: { providerId, modelId: id, model },
    signals: { health: undefined, healthState: 'healthy', circuit: 'CLOSED' },
    score: 1,
    reasons: [],
  };
}

function plan(...ids: string[]): RoutePlan {
  return { strategy: 'explicit', chain: ids.map(scored), rejected: [], reasons: [] };
}

const err = (type: Parameters<typeof GatewayError>[0] extends never ? never : ConstructorParameters<typeof GatewayError>[0], retryAfter?: number) =>
  new GatewayError(type, `synthetic ${type}`, retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {});

function harness(chain: string[]) {
  const clock = new FakeClock();
  const trace = new TraceBuilder('req_1', clock);
  const controller = new AbortController();
  return { clock, trace, controller, plan: plan(...chain) };
}

/** Advance the fake clock whenever the executor sleeps, so tests stay instant. */
function autoAdvance(clock: FakeClock) {
  const timer = setInterval(() => void clock.advance(1_000), 1);
  return () => clearInterval(timer);
}

describe('retry classification', () => {
  it('retries transient provider failures', () => {
    for (const type of ['provider_timeout', 'provider_unavailable', 'provider_overloaded', 'provider_error', 'provider_rate_limit'] as const) {
      expect(isRetryable(err(type), DEFAULT_RETRY_POLICY)).toBe(true);
    }
  });

  it('never retries caller-side failures', () => {
    for (const type of ['invalid_request', 'authentication_error', 'permission_denied', 'model_not_allowed', 'policy_violation', 'budget_exceeded', 'content_filter', 'context_length_exceeded'] as const) {
      expect(isRetryable(err(type), DEFAULT_RETRY_POLICY)).toBe(false);
    }
  });

  it('never retries a non-GatewayError', () => {
    expect(isRetryable(new Error('boom'), DEFAULT_RETRY_POLICY)).toBe(false);
  });
});

describe('backoff', () => {
  it('never waits before the first attempt', () => {
    expect(backoffDelay(1, DEFAULT_RETRY_POLICY)).toBe(0);
  });

  it('grows exponentially and stays under the cap', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: 'none' as const, initialDelayMs: 100, factor: 2, maxDelayMs: 500 };
    expect(backoffSchedule(policy)).toEqual([0, 100, 200]);
    expect(backoffDelay(10, policy)).toBe(500);
  });

  it('applies full jitter within [0, cap]', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1_000, jitter: 'full' as const };
    for (const r of [0, 0.5, 1]) {
      const delay = backoffDelay(2, policy, undefined, () => r);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
    expect(backoffDelay(2, policy, undefined, () => 0)).toBe(0);
  });

  it('applies equal jitter within [cap/2, cap]', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1_000, jitter: 'equal' as const };
    expect(backoffDelay(2, policy, undefined, () => 0)).toBe(500);
    expect(backoffDelay(2, policy, undefined, () => 1)).toBe(1_000);
  });

  it('honours a provider retry-after over the computed backoff', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 100, maxDelayMs: 200 };
    const delay = backoffDelay(2, policy, 30, () => 0);
    expect(delay).toBe(30_000);
  });

  it('adds jitter on top of retry-after so replicas do not resume in lockstep', () => {
    const a = backoffDelay(2, DEFAULT_RETRY_POLICY, 10, () => 0);
    const b = backoffDelay(2, DEFAULT_RETRY_POLICY, 10, () => 1);
    expect(b).toBeGreaterThan(a);
  });

  it('supports linear and constant schedules', () => {
    const linear = { ...DEFAULT_RETRY_POLICY, jitter: 'none' as const, backoff: 'linear' as const, initialDelayMs: 100, maxAttempts: 4 };
    expect(backoffSchedule(linear)).toEqual([0, 100, 200, 300]);
    const constant = { ...linear, backoff: 'constant' as const };
    expect(backoffSchedule(constant)).toEqual([0, 100, 100, 100]);
  });
});

describe('executeWithFallback', () => {
  it('returns the first success without touching the fallbacks', async () => {
    const h = harness(['a/1', 'b/2']);
    const attempt = vi.fn(async () => 'ok');
    const result = await executeWithFallback({ plan: h.plan, retry: DEFAULT_RETRY_POLICY, trace: h.trace, signal: h.controller.signal, clock: h.clock, attempt });
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(result.fallbackUsed).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries the same target before failing over', async () => {
    const h = harness(['a/1', 'b/2']);
    const stop = autoAdvance(h.clock);
    const seen: string[] = [];
    let calls = 0;
    const result = await executeWithFallback({
      plan: h.plan,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, initialDelayMs: 1 },
      trace: h.trace,
      signal: h.controller.signal,
      clock: h.clock,
      random: () => 0,
      attempt: async ({ target }) => {
        seen.push(target.target.modelId);
        if (++calls < 3) throw err('provider_timeout');
        return 'ok';
      },
    });
    stop();
    expect(seen).toEqual(['a/1', 'a/1', 'a/1']);
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it('fails over once a target exhausts its retries', async () => {
    const h = harness(['a/1', 'b/2']);
    const stop = autoAdvance(h.clock);
    const seen: string[] = [];
    const onFallback = vi.fn();
    const result = await executeWithFallback({
      plan: h.plan,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialDelayMs: 1 },
      trace: h.trace,
      signal: h.controller.signal,
      clock: h.clock,
      random: () => 0,
      onFallback,
      attempt: async ({ target }) => {
        seen.push(target.target.modelId);
        if (target.target.modelId === 'a/1') throw err('provider_unavailable');
        return 'ok';
      },
    });
    stop();
    expect(seen).toEqual(['a/1', 'a/1', 'b/2']);
    expect(result.fallbackUsed).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(h.trace.fallbackUsed()).toBe(true);
  });

  it('walks a three-link chain', async () => {
    const h = harness(['a/1', 'b/2', 'c/3']);
    const seen: string[] = [];
    const result = await executeWithFallback({
      plan: h.plan,
      retry: NO_RETRY,
      trace: h.trace,
      signal: h.controller.signal,
      clock: h.clock,
      attempt: async ({ target }) => {
        seen.push(target.target.modelId);
        if (target.target.modelId !== 'c/3') throw err('provider_error');
        return 'ok';
      },
    });
    expect(seen).toEqual(['a/1', 'b/2', 'c/3']);
    expect(result.target.target.modelId).toBe('c/3');
  });

  it('aborts the whole chain on a non-failoverable error', async () => {
    const h = harness(['a/1', 'b/2', 'c/3']);
    const attempt = vi.fn(async () => {
      throw err('invalid_request');
    });
    await expect(
      executeWithFallback({ plan: h.plan, retry: DEFAULT_RETRY_POLICY, trace: h.trace, signal: h.controller.signal, clock: h.clock, attempt }),
    ).rejects.toMatchObject({ type: 'invalid_request' });
    // A malformed request must not be replayed against every provider.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each(['authentication_error', 'permission_denied', 'content_filter', 'budget_exceeded', 'model_not_allowed'] as const)(
    'does not fail over on %s',
    async (type) => {
      const h = harness(['a/1', 'b/2']);
      const attempt = vi.fn(async () => {
        throw err(type);
      });
      await expect(
        executeWithFallback({ plan: h.plan, retry: DEFAULT_RETRY_POLICY, trace: h.trace, signal: h.controller.signal, clock: h.clock, attempt }),
      ).rejects.toMatchObject({ type });
      expect(attempt).toHaveBeenCalledTimes(1);
    },
  );

  it('reports fallback_exhausted with the last error when everything fails', async () => {
    const h = harness(['a/1', 'b/2']);
    await expect(
      executeWithFallback({
        plan: h.plan,
        retry: NO_RETRY,
        trace: h.trace,
        signal: h.controller.signal,
        clock: h.clock,
        attempt: async () => {
          throw err('provider_overloaded');
        },
      }),
    ).rejects.toMatchObject({
      type: 'fallback_exhausted',
      details: { attempts: 2, lastErrorType: 'provider_overloaded' },
    });
  });

  it('stops immediately when the client disconnects', async () => {
    const h = harness(['a/1', 'b/2']);
    const attempt = vi.fn(async () => {
      throw new GatewayError('client_disconnected', 'gone');
    });
    await expect(
      executeWithFallback({ plan: h.plan, retry: DEFAULT_RETRY_POLICY, trace: h.trace, signal: h.controller.signal, clock: h.clock, attempt }),
    ).rejects.toMatchObject({ type: 'client_disconnected' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not start a new attempt after the signal aborts', async () => {
    const h = harness(['a/1', 'b/2']);
    h.controller.abort();
    const attempt = vi.fn(async () => 'ok');
    await expect(
      executeWithFallback({ plan: h.plan, retry: DEFAULT_RETRY_POLICY, trace: h.trace, signal: h.controller.signal, clock: h.clock, attempt }),
    ).rejects.toMatchObject({ type: 'client_disconnected' });
    expect(attempt).not.toHaveBeenCalled();
  });

  it('records every attempt on the trace, with backoff and error detail', async () => {
    const h = harness(['a/1', 'b/2']);
    const stop = autoAdvance(h.clock);
    await executeWithFallback({
      plan: h.plan,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialDelayMs: 100, jitter: 'none' },
      trace: h.trace,
      signal: h.controller.signal,
      clock: h.clock,
      random: () => 1,
      attempt: async ({ target, recorder }) => {
        if (target.target.modelId === 'a/1') throw err('provider_rate_limit');
        recorder.succeed({ input: 1, output: 1, total: 2, source: 'provider_reported' });
        return 'ok';
      },
    });
    stop();
    const { attempts } = h.trace.snapshot();
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toMatchObject({ providerId: 'a', attemptNumber: 1, errorType: 'provider_rate_limit' });
    expect(attempts[1]).toMatchObject({ attemptNumber: 2, backoffMs: 100 });
    expect(attempts[2]).toMatchObject({ providerId: 'b', status: 'success' });
  });

  it('notifies onRetry with the delay it is about to wait', async () => {
    const h = harness(['a/1']);
    const stop = autoAdvance(h.clock);
    const onRetry = vi.fn();
    await expect(
      executeWithFallback({
        plan: h.plan,
        retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialDelayMs: 50, jitter: 'none' },
        trace: h.trace,
        signal: h.controller.signal,
        clock: h.clock,
        onRetry,
        attempt: async () => {
          throw err('provider_error');
        },
      }),
    ).rejects.toThrow();
    stop();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 50, attemptNumber: 2 }));
  });

  it('waits the provider-supplied retry-after before retrying a 429', async () => {
    const h = harness(['a/1']);
    const stop = autoAdvance(h.clock);
    let calls = 0;
    const onRetry = vi.fn();
    await executeWithFallback({
      plan: h.plan,
      retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 },
      trace: h.trace,
      signal: h.controller.signal,
      clock: h.clock,
      random: () => 0,
      onRetry,
      attempt: async () => {
        if (++calls === 1) throw err('provider_rate_limit', 5);
        return 'ok';
      },
    });
    stop();
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 5_000 }));
  });

  it('refuses an empty plan', async () => {
    const h = harness([]);
    await expect(
      executeWithFallback({ plan: h.plan, retry: NO_RETRY, trace: h.trace, signal: h.controller.signal, clock: h.clock, attempt: async () => 'x' }),
    ).rejects.toMatchObject({ type: 'no_route_available' });
  });

  it('bounds total attempts at chain length times max attempts', async () => {
    const h = harness(['a/1', 'b/2', 'c/3']);
    const stop = autoAdvance(h.clock);
    const attempt = vi.fn(async () => {
      throw err('provider_error');
    });
    await expect(
      executeWithFallback({
        plan: h.plan,
        retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialDelayMs: 1 },
        trace: h.trace,
        signal: h.controller.signal,
        clock: h.clock,
        random: () => 0,
        attempt,
      }),
    ).rejects.toMatchObject({ type: 'fallback_exhausted' });
    stop();
    expect(attempt).toHaveBeenCalledTimes(6);
  });
});
