import { describe, expect, it } from 'vitest';
import type { RequestRecord } from '@ai-gateway/core';
import { MemoryKV } from '@ai-gateway/cache';
import { buildState, budgetError, evaluateBudgets, periodBounds, type Budget } from './budget.js';
import { SpendCounters } from './counters.js';
import { compareProviders, groupBy, resolveRange, summarize, timeSeries } from './analytics.js';

function budget(over: Partial<Budget> = {}): Budget {
  return {
    id: 'bud_1',
    organizationId: 'org_1',
    scope: 'organization',
    period: 'monthly',
    limit: 100,
    currency: 'USD',
    action: 'BLOCK',
    enabled: true,
    ...over,
  };
}

describe('budget evaluation', () => {
  it('allows a request that fits inside the remaining budget', () => {
    const outcome = evaluateBudgets({ states: [buildState(budget(), 10)], projectedCost: 1 });
    expect(outcome.decision).toBe('allow');
  });

  it('blocks when the projected cost would cross the limit', () => {
    const outcome = evaluateBudgets({ states: [buildState(budget({ limit: 100 }), 99.5)], projectedCost: 1 });
    expect(outcome.decision).toBe('block');
  });

  it('blocks on the projection, not only after the fact', () => {
    // 50 spent of 100, a single request projected at 60 must not be admitted.
    const outcome = evaluateBudgets({ states: [buildState(budget(), 50)], projectedCost: 60 });
    expect(outcome.decision).toBe('block');
  });

  it('lets a WARN budget through but reports it', () => {
    const outcome = evaluateBudgets({ states: [buildState(budget({ action: 'WARN' }), 200)], projectedCost: 1 });
    expect(outcome.decision).toBe('allow');
    expect(outcome.warnings).toHaveLength(1);
  });

  it('signals a downgrade with the spend headroom left', () => {
    const outcome = evaluateBudgets({
      states: [buildState(budget({ action: 'FALLBACK_TO_CHEAPER_MODEL', limit: 100 }), 99.5)],
      projectedCost: 5,
    });
    expect(outcome.decision).toBe('downgrade');
    expect(outcome.decision === 'downgrade' && outcome.maxSpend).toBeCloseTo(0.5, 6);
  });

  it('lets BLOCK win over a downgrade at another scope', () => {
    const outcome = evaluateBudgets({
      states: [
        buildState(budget({ id: 'b1', scope: 'project', action: 'FALLBACK_TO_CHEAPER_MODEL', limit: 1 }), 1),
        buildState(budget({ id: 'b2', scope: 'organization', action: 'BLOCK', limit: 1 }), 1),
      ],
      projectedCost: 1,
    });
    expect(outcome.decision).toBe('block');
    expect(outcome.decision === 'block' && outcome.blocked.budget.id).toBe('b2');
  });

  it('fires warnings at the configured threshold before the limit is hit', () => {
    const outcome = evaluateBudgets({
      states: [buildState(budget({ warnThreshold: 0.8, limit: 100 }), 85)],
      projectedCost: 1,
    });
    expect(outcome.decision).toBe('allow');
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.utilization).toBeCloseTo(0.85);
  });

  it('ignores disabled budgets', () => {
    const outcome = evaluateBudgets({ states: [buildState(budget({ enabled: false, limit: 1 }), 100)], projectedCost: 50 });
    expect(outcome.decision).toBe('allow');
    expect(outcome.states).toHaveLength(0);
  });

  it('produces an error that names the limit without leaking other tenants', () => {
    const err = budgetError(buildState(budget({ limit: 100 }), 100));
    expect(err.type).toBe('budget_exceeded');
    expect(err.status).toBe(402);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('monthly');
    expect(err.details?.['limit']).toBe(100);
  });
});

describe('period bounds', () => {
  it('computes UTC day boundaries', () => {
    const { start, end, key } = periodBounds('daily', new Date('2026-03-15T23:59:00Z'));
    expect(start.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(key).toBe('2026-03-15');
  });

  it('computes UTC month boundaries across a year end', () => {
    const { start, end, key } = periodBounds('monthly', new Date('2026-12-31T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(key).toBe('2026-12');
  });
});

describe('SpendCounters', () => {
  const ctx = { organizationId: 'org_1', projectId: 'proj_1', apiKeyId: 'key_1' };

  it('accumulates spend across all three scopes and both periods', async () => {
    const counters = new SpendCounters(new MemoryKV());
    await counters.record(ctx, 1.5);
    await counters.record(ctx, 2.5);
    expect(await counters.read('org_1', 'organization', 'org_1', 'monthly')).toBeCloseTo(4);
    expect(await counters.read('org_1', 'project', 'proj_1', 'daily')).toBeCloseTo(4);
    expect(await counters.read('org_1', 'api_key', 'key_1', 'monthly')).toBeCloseTo(4);
  });

  it('keeps separate counters per period', async () => {
    const counters = new SpendCounters(new MemoryKV());
    await counters.record(ctx, 10, new Date('2026-03-15T00:00:00Z'));
    await counters.record(ctx, 10, new Date('2026-03-16T00:00:00Z'));
    expect(await counters.read('org_1', 'organization', 'org_1', 'daily', new Date('2026-03-16T00:00:00Z'))).toBeCloseTo(10);
    expect(await counters.read('org_1', 'organization', 'org_1', 'monthly', new Date('2026-03-16T00:00:00Z'))).toBeCloseTo(20);
  });

  it('never records a non-positive amount', async () => {
    const counters = new SpendCounters(new MemoryKV());
    await counters.record(ctx, 0);
    await counters.record(ctx, -5);
    expect(await counters.read('org_1', 'organization', 'org_1', 'monthly')).toBe(0);
  });

  it('can be reconciled from the requests table', async () => {
    const counters = new SpendCounters(new MemoryKV());
    await counters.record(ctx, 99);
    await counters.reconcile('org_1', 'organization', 'org_1', 'monthly', 42);
    expect(await counters.read('org_1', 'organization', 'org_1', 'monthly')).toBe(42);
  });

  it('reads the counter a budget points at', async () => {
    const counters = new SpendCounters(new MemoryKV());
    await counters.record(ctx, 7);
    expect(await counters.readForBudget(budget({ scope: 'project', scopeId: 'proj_1' }))).toBeCloseTo(7);
  });
});

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'req_1',
    organizationId: 'org_1',
    projectId: 'proj_1',
    apiKeyId: 'key_1',
    createdAt: '2026-03-15T12:00:00.000Z',
    endpoint: '/v1/chat/completions',
    requestedModel: 'gateway/auto',
    resolvedProviderId: 'mock',
    resolvedModelId: 'mock/mock-fast',
    status: 'success',
    httpStatus: 200,
    streamed: false,
    latencyMs: 100,
    cacheStatus: 'miss',
    fallbackUsed: false,
    attemptCount: 1,
    usage: { input: 100, output: 50, total: 150, source: 'provider_reported' },
    estimatedCost: 0.01,
    currency: 'USD',
    pricingVersion: 'seed-unverified-v1',
    isTest: false,
    ...over,
  };
}

describe('usage summary', () => {
  it('aggregates requests, tokens, cost and rates', () => {
    const summary = summarize([
      record(),
      record({ id: 'r2', status: 'error', errorType: 'provider_timeout', httpStatus: 504, latencyMs: 500, usage: undefined, estimatedCost: 0 }),
      record({ id: 'r3', cacheStatus: 'exact_hit', latencyMs: 5 }),
      record({ id: 'r4', fallbackUsed: true }),
    ]);
    expect(summary.totalRequests).toBe(4);
    expect(summary.successfulRequests).toBe(3);
    expect(summary.failedRequests).toBe(1);
    expect(summary.successRate).toBe(0.75);
    expect(summary.totalTokens).toBe(450);
    expect(summary.estimatedCost).toBeCloseTo(0.03);
    expect(summary.cacheHitRate).toBe(0.25);
    expect(summary.fallbackRate).toBe(0.25);
  });

  it('excludes test traffic from production analytics by default', () => {
    const rows = [record(), record({ id: 'r2', isTest: true, estimatedCost: 99 })];
    expect(summarize(rows).totalRequests).toBe(1);
    expect(summarize(rows).estimatedCost).toBeCloseTo(0.01);
    expect(summarize(rows, { includeTest: true }).totalRequests).toBe(2);
  });

  it('reports the share of requests whose usage was estimated', () => {
    const rows = [
      record(),
      record({ id: 'r2', usage: { input: 10, output: 5, total: 15, source: 'estimated' } }),
    ];
    expect(summarize(rows).estimatedUsageShare).toBe(0.5);
  });

  it('lists every pricing version the totals were computed with', () => {
    const rows = [record(), record({ id: 'r2', pricingVersion: 'v2' })];
    expect(summarize(rows).pricingVersions).toEqual(['seed-unverified-v1', 'v2']);
  });

  it('handles an empty window without dividing by zero', () => {
    const summary = summarize([]);
    expect(summary.successRate).toBe(0);
    expect(summary.cacheHitRate).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
    expect(summary.avgTimeToFirstTokenMs).toBeNull();
  });
});

describe('time series', () => {
  it('buckets requests and emits empty buckets for gaps', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    const bounds = resolveRange('1h', undefined, undefined, now);
    const points = timeSeries(
      [record({ createdAt: '2026-03-15T11:30:00.000Z' }), record({ id: 'r2', createdAt: '2026-03-15T11:30:30.000Z' })],
      bounds,
    );
    expect(points.length).toBeGreaterThan(50);
    expect(points.reduce((s, p) => s + p.requests, 0)).toBe(2);
    expect(points.some((p) => p.requests === 0)).toBe(true);
  });

  it('ignores records outside the range', () => {
    const bounds = resolveRange('1h', undefined, undefined, new Date('2026-03-15T12:00:00Z'));
    const points = timeSeries([record({ createdAt: '2020-01-01T00:00:00.000Z' })], bounds);
    expect(points.reduce((s, p) => s + p.requests, 0)).toBe(0);
  });

  it('keeps every range near sixty buckets', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    for (const range of ['1h', '24h', '7d', '30d', '90d'] as const) {
      const bounds = resolveRange(range, undefined, undefined, now);
      const points = timeSeries([], bounds);
      expect(points.length).toBeGreaterThan(20);
      expect(points.length).toBeLessThan(200);
    }
  });
});

describe('grouping and provider comparison', () => {
  const rows = [
    record({ resolvedProviderId: 'openai', latencyMs: 100 }),
    record({ id: 'r2', resolvedProviderId: 'openai', latencyMs: 300, status: 'error', errorType: 'provider_timeout' }),
    record({ id: 'r3', resolvedProviderId: 'anthropic', latencyMs: 200 }),
  ];

  it('groups by provider, sorted by volume', () => {
    const groups = groupBy(rows, 'provider');
    expect(groups[0]?.key).toBe('openai');
    expect(groups[0]?.requests).toBe(2);
    expect(groups[0]?.successRate).toBe(0.5);
  });

  it('groups by error type, skipping successes', () => {
    const groups = groupBy(rows, 'errorType');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('provider_timeout');
  });

  it('compares providers on measurements only, with the range attached', () => {
    const bounds = resolveRange('24h', undefined, undefined, new Date('2026-03-15T13:00:00Z'));
    const comparison = compareProviders(rows, bounds);
    const openai = comparison.find((c) => c.providerId === 'openai');
    expect(openai?.requests).toBe(2);
    expect(openai?.successRate).toBe(0.5);
    expect(openai?.measuredFrom).toBeDefined();
    expect(openai?.usageSourceMix.provider_reported).toBe(2);
    // No composite score or quality ranking is produced anywhere.
    expect(Object.keys(openai ?? {})).not.toContain('score');
    expect(Object.keys(openai ?? {})).not.toContain('quality');
  });

  it('reports cost per million tokens only when tokens were counted', () => {
    const bounds = resolveRange('24h', undefined, undefined, new Date('2026-03-15T13:00:00Z'));
    const noTokens = compareProviders([record({ usage: undefined })], bounds);
    expect(noTokens[0]?.costPerMillionTokens).toBeNull();
  });
});
