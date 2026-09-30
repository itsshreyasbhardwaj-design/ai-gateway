import { describe, expect, it } from 'vitest';
import { FakeClock } from '@ai-gateway/core';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  DEFAULT_CIRCUIT_CONFIG,
} from './circuit-breaker.js';
import { HealthTracker, percentile, healthScore } from './health.js';
import { Logger, MemorySink } from './logger.js';
import { MetricsRegistry, METRICS } from './metrics.js';
import { TraceBuilder } from './trace.js';

describe('CircuitBreaker', () => {
  const config = {
    ...DEFAULT_CIRCUIT_CONFIG,
    failureThreshold: 3,
    openDurationMs: 1_000,
    successThreshold: 2,
    halfOpenProbes: 2,
  };

  it('stays closed after a single failure', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('p', config, clock);
    breaker.recordFailure();
    expect(breaker.currentState).toBe('CLOSED');
    expect(breaker.allow()).toBe(true);
  });

  it('opens after consecutive failures reach the threshold', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('p', config, clock);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('CLOSED');
    breaker.recordFailure();
    expect(breaker.currentState).toBe('OPEN');
    expect(breaker.allow()).toBe(false);
  });

  it('resets the consecutive run on success', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('p', config, clock);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('opens on a sustained failure rate once minimum throughput is met', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(
      'p',
      { ...config, failureThreshold: 100, minimumThroughput: 10, failureRateThreshold: 0.5 },
      clock,
    );
    for (let i = 0; i < 10; i++) {
      // Alternate so the consecutive-failure rule never fires.
      if (i % 2 === 0) breaker.recordFailure();
      else breaker.recordSuccess();
    }
    breaker.recordFailure();
    expect(breaker.currentState).toBe('OPEN');
  });

  it('moves to HALF_OPEN after the open period and closes on successful probes', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('p', config, clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.allow()).toBe(false);

    await clock.advance(1_000);
    expect(breaker.allow()).toBe(true);
    expect(breaker.currentState).toBe('HALF_OPEN');

    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('re-opens immediately when a probe fails', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('p', config, clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await clock.advance(1_000);
    expect(breaker.allow()).toBe(true);
    breaker.recordFailure();
    expect(breaker.currentState).toBe('OPEN');
    expect(breaker.allow()).toBe(false);
  });

  it('limits concurrent probes in HALF_OPEN', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker('p', config, clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await clock.advance(1_000);
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false);
  });

  it('drops outcomes outside the rolling window', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker(
      'p',
      {
        ...config,
        rollingWindowMs: 1_000,
        failureThreshold: 100,
        minimumThroughput: 2,
        failureRateThreshold: 0.5,
      },
      clock,
    );
    breaker.recordFailure();
    breaker.recordFailure();
    await clock.advance(2_000);
    expect(breaker.snapshot().windowTotal).toBe(0);
  });

  it('exposes a retryAt so callers can report when routing will resume', () => {
    const clock = new FakeClock(5_000);
    const breaker = new CircuitBreaker('p', config, clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.snapshot().retryAt).toBe(6_000);
  });

  it('supports an operator reset', () => {
    const breaker = new CircuitBreaker('p', config, new FakeClock());
    breaker.forceOpen();
    expect(breaker.currentState).toBe('OPEN');
    breaker.reset();
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('keeps a separate breaker per key', () => {
    const registry = new CircuitBreakerRegistry(config, new FakeClock());
    for (let i = 0; i < 3; i++) registry.get('a').recordFailure();
    expect(registry.get('a').currentState).toBe('OPEN');
    expect(registry.get('b').currentState).toBe('CLOSED');
    expect(registry.snapshots()).toHaveLength(2);
  });
});

describe('HealthTracker', () => {
  it('reports unknown until it has enough samples', () => {
    const tracker = new HealthTracker({
      windowMs: 60_000,
      maxSamples: 100,
      degradedBelowSuccessRate: 0.95,
      unavailableBelowSuccessRate: 0.5,
      minimumSamples: 10,
    });
    tracker.recordFailure('p', 10, 'provider_error');
    expect(tracker.stats('p').state).toBe('unknown');
  });

  it('classifies degraded and unavailable from the success rate', () => {
    const config = {
      windowMs: 60_000,
      maxSamples: 100,
      degradedBelowSuccessRate: 0.95,
      unavailableBelowSuccessRate: 0.5,
      minimumSamples: 10,
    };
    const degraded = new HealthTracker(config);
    for (let i = 0; i < 9; i++) degraded.recordSuccess('p', 10);
    degraded.recordFailure('p', 10, 'provider_error');
    expect(degraded.stats('p').state).toBe('degraded');

    const down = new HealthTracker(config);
    for (let i = 0; i < 8; i++) down.recordFailure('p', 10, 'provider_error');
    for (let i = 0; i < 2; i++) down.recordSuccess('p', 10);
    expect(down.stats('p').state).toBe('unavailable');
  });

  it('computes latency percentiles over successes only', () => {
    const tracker = new HealthTracker();
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) tracker.recordSuccess('p', ms);
    tracker.recordFailure('p', 99_999, 'provider_timeout');
    const stats = tracker.stats('p');
    expect(stats.p50LatencyMs).toBeCloseTo(55, 0);
    expect(stats.p95LatencyMs).toBeLessThanOrEqual(100);
    expect(stats.avgLatencyMs).toBeCloseTo(55, 0);
  });

  it('breaks out timeout and rate-limit rates', () => {
    const tracker = new HealthTracker();
    for (let i = 0; i < 5; i++) tracker.recordFailure('p', 10, 'provider_timeout');
    for (let i = 0; i < 5; i++) tracker.recordFailure('p', 10, 'provider_rate_limit');
    const stats = tracker.stats('p');
    expect(stats.timeoutRate).toBe(0.5);
    expect(stats.rateLimitRate).toBe(0.5);
  });

  it('forgets samples older than the window', async () => {
    const clock = new FakeClock();
    const tracker = new HealthTracker(
      {
        windowMs: 1_000,
        maxSamples: 100,
        degradedBelowSuccessRate: 0.95,
        unavailableBelowSuccessRate: 0.5,
        minimumSamples: 1,
      },
      clock,
    );
    tracker.recordFailure('p', 10, 'provider_error');
    expect(tracker.stats('p').total).toBe(1);
    await clock.advance(2_000);
    expect(tracker.stats('p').total).toBe(0);
  });

  it('scores health states for weighted routing', () => {
    expect(healthScore('healthy')).toBe(1);
    expect(healthScore('unknown')).toBeGreaterThan(healthScore('degraded'));
    expect(healthScore('unavailable')).toBe(0);
  });

  it('interpolates percentiles', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([5], 0.99)).toBe(5);
    expect(percentile([0, 100], 0.5)).toBe(50);
  });
});

describe('Logger redaction', () => {
  it('redacts secrets in message text and field values', () => {
    const sink = new MemorySink();
    new Logger(sink, 'debug').info('calling with sk-abcdefghijklmnopqrstuvwxyz', {
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      apiKey: 'aigw_live_abcdefgh12345678',
      provider: 'openai',
    });
    expect(sink.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(sink.text).not.toContain('aigw_live_abcdefgh12345678');
    expect(sink.text).toContain('[redacted]');
    expect(sink.text).toContain('openai');
  });

  it('redacts nested structures', () => {
    const sink = new MemorySink();
    new Logger(sink, 'debug').error('failed', {
      detail: {
        provider: { credential: 'sk-ant-abcdefghijklmnopqrstuv', baseUrl: 'https://x.example' },
      },
    });
    expect(sink.text).not.toContain('sk-ant-abcdefghijklmnopqrstuv');
    expect(sink.text).toContain('https://x.example');
  });

  it('honours the minimum level', () => {
    const sink = new MemorySink();
    const logger = new Logger(sink, 'warn');
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    expect(sink.records).toHaveLength(1);
  });

  it('merges child context', () => {
    const sink = new MemorySink();
    new Logger(sink, 'info').child({ requestId: 'req_1' }).info('hi', { provider: 'p' });
    expect(sink.records[0]).toMatchObject({ requestId: 'req_1', provider: 'p' });
  });
});

describe('MetricsRegistry', () => {
  it('counts, gauges and observes with labels', () => {
    const registry = new MetricsRegistry();
    registry.increment(METRICS.requests, { status: 'success' });
    registry.increment(METRICS.requests, { status: 'success' });
    registry.increment(METRICS.requests, { status: 'error' });
    registry.setGauge(METRICS.circuitState, 2, { provider: 'p' });
    registry.observe(METRICS.requestDuration, 120, { provider: 'p' });

    expect(registry.getCounter(METRICS.requests, { status: 'success' })).toBe(2);
    expect(registry.getCounter(METRICS.requests, { status: 'error' })).toBe(1);
    expect(registry.getGauge(METRICS.circuitState, { provider: 'p' })).toBe(2);
    expect(registry.getHistogram(METRICS.requestDuration, { provider: 'p' })).toEqual({
      count: 1,
      sum: 120,
    });
  });

  it('renders Prometheus exposition format', () => {
    const registry = new MetricsRegistry();
    registry.describe(METRICS.requests, 'Requests.');
    registry.increment(METRICS.requests, { status: 'success', provider: 'openai' });
    registry.observe(METRICS.requestDuration, 50);
    const text = registry.render();
    expect(text).toContain('# TYPE aigw_requests_total counter');
    expect(text).toContain('aigw_requests_total{provider="openai",status="success"} 1');
    expect(text).toContain('aigw_request_duration_ms_bucket{le="+Inf"} 1');
    expect(text).toContain('aigw_request_duration_ms_sum 50');
  });

  it('escapes label values', () => {
    const registry = new MetricsRegistry();
    registry.increment('m', { model: 'a"b\\c' });
    expect(registry.render()).toContain('model="a\\"b\\\\c"');
  });
});

describe('TraceBuilder', () => {
  it('times steps and records failures', async () => {
    const clock = new FakeClock(1_000);
    const trace = new TraceBuilder('req_1', clock);
    const step = trace.step('policy_evaluation');
    await clock.advance(5);
    step.end({ allowed: true });

    const denied = trace.step('budget_check');
    await clock.advance(2);
    denied.fail('budget_exceeded', 'monthly budget spent');

    const skipped = trace.step('cache_lookup');
    skipped.skip('caching disabled for this request');

    const { steps } = trace.snapshot();
    expect(steps[0]).toMatchObject({
      name: 'policy_evaluation',
      status: 'ok',
      durationMs: 5,
      detail: { allowed: true },
    });
    expect(steps[1]).toMatchObject({
      name: 'budget_check',
      status: 'error',
      errorType: 'budget_exceeded',
    });
    expect(steps[2]).toMatchObject({ status: 'skipped' });
  });

  it('records attempts and detects that a fallback served the request', async () => {
    const clock = new FakeClock();
    const trace = new TraceBuilder('req_1', clock);

    const first = trace.startAttempt('openai', 'openai/m1', 1);
    await clock.advance(100);
    first.fail('provider_timeout', 'timed out');

    const second = trace.startAttempt('anthropic', 'anthropic/m2', 2, 250);
    await clock.advance(50);
    second.firstToken();
    second.succeed({ input: 10, output: 5, total: 15, source: 'provider_reported' });

    const { attempts } = trace.snapshot();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      status: 'error',
      errorType: 'provider_timeout',
      durationMs: 100,
    });
    expect(attempts[1]).toMatchObject({
      status: 'success',
      backoffMs: 250,
      timeToFirstTokenMs: 50,
    });
    expect(trace.fallbackUsed()).toBe(true);
    expect(trace.finishedStatus()).toBe('success');
  });

  it('does not report a fallback when the first target succeeded', async () => {
    const clock = new FakeClock();
    const trace = new TraceBuilder('req_1', clock);
    const only = trace.startAttempt('openai', 'openai/m1', 1);
    await clock.advance(10);
    only.succeed();
    expect(trace.fallbackUsed()).toBe(false);
  });

  it('separates gateway overhead from provider time', async () => {
    const clock = new FakeClock();
    const trace = new TraceBuilder('req_1', clock);
    await clock.advance(20); // gateway work before dispatch
    const attempt = trace.startAttempt('openai', 'openai/m1', 1);
    await clock.advance(500); // provider time
    attempt.succeed();
    await clock.advance(5); // gateway work after
    expect(trace.elapsedMs).toBe(525);
    expect(trace.overheadMs()).toBe(25);
  });

  it('reports a cancelled request distinctly from an error', async () => {
    const clock = new FakeClock();
    const trace = new TraceBuilder('req_1', clock);
    const attempt = trace.startAttempt('openai', 'openai/m1', 1);
    attempt.fail('client_disconnected', 'client hung up');
    expect(trace.finishedStatus()).toBe('cancelled');
  });
});
