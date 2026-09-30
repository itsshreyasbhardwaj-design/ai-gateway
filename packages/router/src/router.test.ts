import { describe, expect, it } from 'vitest';
import { GatewayError, type ChatRequest, type ModelDescriptor } from '@ai-gateway/core';
import type { HealthStats } from '@ai-gateway/observability';
import { planRoute, resolveCandidates } from './router.js';
import { requiredCapabilities, type RouteTarget, type TargetSignals } from './types.js';

function model(id: string, over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  const [providerId = 'p', providerModelId = 'm'] = id.split('/');
  return {
    id,
    providerId,
    providerModelId,
    displayName: id,
    contextWindow: 100_000,
    capabilities: ['chat', 'streaming'],
    status: 'available',
    ...over,
  };
}

function target(
  id: string,
  over: Partial<RouteTarget> = {},
  modelOver: Partial<ModelDescriptor> = {},
): RouteTarget {
  const m = model(id, modelOver);
  return { providerId: m.providerId, modelId: m.id, model: m, ...over };
}

function stats(over: Partial<HealthStats> = {}): HealthStats {
  return {
    key: 'k',
    total: 100,
    successes: 100,
    failures: 0,
    successRate: 1,
    errorRate: 0,
    timeoutRate: 0,
    rateLimitRate: 0,
    p50LatencyMs: 100,
    p95LatencyMs: 200,
    p99LatencyMs: 300,
    avgLatencyMs: 120,
    state: 'healthy',
    windowMs: 300_000,
    ...over,
  };
}

function signalsFor(map: Record<string, Partial<TargetSignals>> = {}) {
  return (t: RouteTarget): TargetSignals => ({
    health: stats(),
    healthState: 'healthy',
    circuit: 'CLOSED',
    p95LatencyMs: 200,
    successRate: 1,
    ...map[t.modelId],
  });
}

const chat: ChatRequest = { model: 'a/one', messages: [{ role: 'user', content: 'hi' }] };

describe('requiredCapabilities', () => {
  it('derives capabilities from the request shape', () => {
    expect(requiredCapabilities(chat)).toEqual(['chat']);
    expect(requiredCapabilities({ ...chat, stream: true })).toContain('streaming');
    expect(
      requiredCapabilities({ ...chat, tools: [{ type: 'function', function: { name: 'f' } }] }),
    ).toContain('tools');
    expect(
      requiredCapabilities({
        ...chat,
        response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
      }),
    ).toContain('structured-output');
    expect(requiredCapabilities({ ...chat, response_format: { type: 'json_object' } })).toContain(
      'json-mode',
    );
    expect(
      requiredCapabilities({
        ...chat,
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x' } }] },
        ],
      }),
    ).toContain('vision');
  });
});

describe('planRoute - eligibility', () => {
  it('never routes a request to a model missing a required capability', () => {
    const plan = planRoute({
      request: chat,
      candidates: [
        target('a/no-tools'),
        target('b/has-tools', {}, { capabilities: ['chat', 'streaming', 'tools'] }),
      ],
      strategy: 'explicit',
      requiredCapabilities: ['chat', 'tools'],
      signals: signalsFor(),
    });
    expect(plan.chain[0]?.target.modelId).toBe('b/has-tools');
    expect(plan.rejected[0]).toMatchObject({ reason: expect.stringContaining('tools') });
  });

  it('excludes targets with an open circuit and explains why', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/one'), target('b/two')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor({ 'a/one': { circuit: 'OPEN' } }),
    });
    expect(plan.chain.map((c) => c.target.modelId)).toEqual(['b/two']);
    expect(plan.rejected[0]?.reason).toContain('circuit breaker is open');
  });

  it('excludes targets measured as unavailable', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/one'), target('b/two')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/one': { healthState: 'unavailable', health: stats({ successRate: 0.2 }) },
      }),
    });
    expect(plan.rejected[0]?.reason).toContain('unavailable');
    expect(plan.rejected[0]?.reason).toContain('20%');
  });

  it('excludes disabled models', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/one', {}, { status: 'disabled' }), target('b/two')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor(),
    });
    expect(plan.chain).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toBe('model is disabled');
  });

  it('excludes targets whose projected cost exceeds the remaining budget', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/expensive'), target('b/cheap')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      remainingBudget: 0.01,
      signals: signalsFor({
        'a/expensive': { projectedCost: 5 },
        'b/cheap': { projectedCost: 0.001 },
      }),
    });
    expect(plan.chain[0]?.target.modelId).toBe('b/cheap');
    expect(plan.rejected[0]?.reason).toContain('exceeds remaining budget');
  });

  it('throws no_route_available, listing rejections, when nothing is eligible', () => {
    try {
      planRoute({
        request: chat,
        candidates: [target('a/one')],
        strategy: 'explicit',
        requiredCapabilities: ['vision'],
        signals: signalsFor(),
      });
      expect.unreachable();
    } catch (err) {
      expect(GatewayError.is(err)).toBe(true);
      const gw = err as GatewayError;
      expect(gw.type).toBe('no_route_available');
      expect(gw.details?.['rejected'] as unknown[]).toHaveLength(1);
    }
  });

  it('keeps degraded targets routable but ranks them lower', () => {
    // Equal projected cost, so the health penalty is what decides the order.
    const plan = planRoute({
      request: chat,
      candidates: [target('a/degraded'), target('b/healthy')],
      strategy: 'lowest_cost',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/degraded': { healthState: 'degraded', projectedCost: 0.01 },
        'b/healthy': { projectedCost: 0.01 },
      }),
    });
    expect(plan.chain.map((c) => c.target.modelId)).toEqual(['b/healthy', 'a/degraded']);
    expect(plan.chain[1]?.reasons.join(' ')).toContain('degraded');
  });

  it('lets an explicitly ordered chain keep a degraded target first', () => {
    // Under `explicit` the operator's ordering is the intent. A degraded target
    // is demoted but not overtaken, because the caller asked for it by name.
    const plan = planRoute({
      request: chat,
      candidates: [target('a/degraded'), target('b/healthy')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor({ 'a/degraded': { healthState: 'degraded' } }),
    });
    expect(plan.chain[0]?.target.modelId).toBe('a/degraded');
    expect(plan.chain[0]?.reasons.join(' ')).toContain('degraded');
  });

  it('half-open circuits are probed but rank behind closed ones', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/probing'), target('b/closed')],
      strategy: 'lowest_cost',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/probing': { circuit: 'HALF_OPEN', projectedCost: 0.01 },
        'b/closed': { projectedCost: 0.01 },
      }),
    });
    expect(plan.chain.map((c) => c.target.modelId)).toEqual(['b/closed', 'a/probing']);
    expect(plan.chain[1]?.reasons.join(' ')).toContain('half-open');
  });
});

describe('planRoute - strategies', () => {
  const three = [target('a/cheap'), target('b/mid'), target('c/pricey')];

  it('lowest_cost picks the cheapest projected cost', () => {
    const plan = planRoute({
      request: chat,
      candidates: three,
      strategy: 'lowest_cost',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/cheap': { projectedCost: 0.001 },
        'b/mid': { projectedCost: 0.01 },
        'c/pricey': { projectedCost: 1 },
      }),
    });
    expect(plan.chain.map((c) => c.target.modelId)).toEqual(['a/cheap', 'b/mid', 'c/pricey']);
    expect(plan.reasons.join(' ')).toContain('lowest projected cost');
  });

  it('lowest_cost ranks unpriced models last rather than treating them as free', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/unpriced'), target('b/priced')],
      strategy: 'lowest_cost',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/unpriced': { projectedCost: undefined },
        'b/priced': { projectedCost: 0.5 },
      }),
    });
    expect(plan.chain[0]?.target.modelId).toBe('b/priced');
  });

  it('lowest_latency uses measured p95', () => {
    const plan = planRoute({
      request: chat,
      candidates: three,
      strategy: 'lowest_latency',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/cheap': { p95LatencyMs: 900 },
        'b/mid': { p95LatencyMs: 120 },
        'c/pricey': { p95LatencyMs: 400 },
      }),
    });
    expect(plan.chain[0]?.target.modelId).toBe('b/mid');
    expect(plan.chain[0]?.reasons.join(' ')).toContain('120ms');
  });

  it('lowest_latency treats an unmeasured target as mid-pack, not best', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/unknown'), target('b/fast')],
      strategy: 'lowest_latency',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/unknown': { p95LatencyMs: undefined, health: stats({ total: 0, successes: 0 }) },
        'b/fast': { p95LatencyMs: 50 },
      }),
    });
    expect(plan.chain[0]?.target.modelId).toBe('b/fast');
  });

  it('highest_reliability uses the measured success rate', () => {
    const plan = planRoute({
      request: chat,
      candidates: three,
      strategy: 'highest_reliability',
      requiredCapabilities: ['chat'],
      signals: signalsFor({
        'a/cheap': { health: stats({ successRate: 0.8 }) },
        'b/mid': { health: stats({ successRate: 0.999 }) },
        'c/pricey': { health: stats({ successRate: 0.9 }) },
      }),
    });
    expect(plan.chain[0]?.target.modelId).toBe('b/mid');
    expect(plan.chain[0]?.reasons.join(' ')).toMatch(/success rate 99\.9%/);
  });

  it('priority honours the operator ordering', () => {
    const plan = planRoute({
      request: chat,
      candidates: [
        target('a/one', { priority: 30 }),
        target('b/two', { priority: 10 }),
        target('c/three', { priority: 20 }),
      ],
      strategy: 'priority',
      requiredCapabilities: ['chat'],
      signals: signalsFor(),
    });
    expect(plan.chain.map((c) => c.target.modelId)).toEqual(['b/two', 'c/three', 'a/one']);
  });

  it('round_robin advances with the cursor', () => {
    const candidates = [target('a/one'), target('b/two'), target('c/three')];
    const pick = (cursor: number) =>
      planRoute({
        request: chat,
        candidates,
        strategy: 'round_robin',
        requiredCapabilities: ['chat'],
        signals: signalsFor(),
        roundRobinCursor: cursor,
      }).chain[0]?.target.modelId;
    expect([pick(0), pick(1), pick(2), pick(3)]).toEqual(['a/one', 'b/two', 'c/three', 'a/one']);
  });

  it('weighted distributes across the cursor space roughly by weight', () => {
    const candidates = [target('a/heavy', { weight: 9 }), target('b/light', { weight: 1 })];
    let heavy = 0;
    for (let cursor = 0; cursor < 1000; cursor++) {
      const winner = planRoute({
        request: chat,
        candidates,
        strategy: 'weighted',
        requiredCapabilities: ['chat'],
        signals: signalsFor(),
        roundRobinCursor: cursor,
      }).chain[0]?.target.modelId;
      if (winner === 'a/heavy') heavy++;
    }
    expect(heavy).toBeGreaterThan(850);
    expect(heavy).toBeLessThan(950);
  });

  it('explicit preserves the declared order', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('c/third'), target('a/first'), target('b/second')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor(),
    });
    expect(plan.chain.map((c) => c.target.modelId)).toEqual(['c/third', 'a/first', 'b/second']);
  });

  it('is deterministic for identical input', () => {
    const args = {
      request: chat,
      candidates: [target('a/one'), target('b/two')],
      strategy: 'lowest_cost' as const,
      requiredCapabilities: ['chat' as const],
      signals: signalsFor({ 'a/one': { projectedCost: 1 }, 'b/two': { projectedCost: 1 } }),
    };
    expect(planRoute(args).chain.map((c) => c.target.modelId)).toEqual(
      planRoute(args).chain.map((c) => c.target.modelId),
    );
  });
});

describe('planRoute - chain shape', () => {
  it('caps the chain length', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/1'), target('b/2'), target('c/3'), target('d/4')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor(),
      maxChainLength: 2,
    });
    expect(plan.chain).toHaveLength(2);
  });

  it('returns a single target when fallback is disabled', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/1'), target('b/2')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor(),
      fallbackEnabled: false,
    });
    expect(plan.chain).toHaveLength(1);
    expect(plan.reasons).toContain('fallback disabled for this request');
  });

  it('explains the chain in the plan reasons', () => {
    const plan = planRoute({
      request: chat,
      candidates: [target('a/1'), target('b/2')],
      strategy: 'explicit',
      requiredCapabilities: ['chat'],
      signals: signalsFor(),
    });
    expect(plan.reasons.join(' ')).toContain('fallback chain: b/2');
    expect(plan.reasons.join(' ')).toContain('2 of 2 candidates eligible');
  });
});

describe('resolveCandidates', () => {
  const allowed = [target('openai/a'), target('anthropic/b'), target('google/c')];

  it('puts an explicitly requested model first, then the policy chain', () => {
    const result = resolveCandidates({
      requestedModel: 'anthropic/b',
      allowed,
      policyModels: ['openai/a', 'anthropic/b', 'google/c'],
    });
    expect(result.candidates.map((c) => c.modelId)).toEqual([
      'anthropic/b',
      'openai/a',
      'google/c',
    ]);
    expect(result.impliedStrategy).toBe('explicit');
  });

  it('maps gateway/* aliases onto strategies', () => {
    expect(resolveCandidates({ requestedModel: 'gateway/cheapest', allowed }).impliedStrategy).toBe(
      'lowest_cost',
    );
    expect(resolveCandidates({ requestedModel: 'gateway/fastest', allowed }).impliedStrategy).toBe(
      'lowest_latency',
    );
    expect(resolveCandidates({ requestedModel: 'gateway/auto', allowed }).impliedStrategy).toBe(
      'highest_reliability',
    );
  });

  it('honours a per-request candidate list', () => {
    const result = resolveCandidates({
      requestedModel: 'gateway/auto',
      allowed,
      explicitModels: ['google/c', 'openai/a'],
    });
    expect(result.candidates.map((c) => c.modelId)).toEqual(['google/c', 'openai/a']);
  });

  it('rejects a request listing only models the project cannot use', () => {
    expect(() =>
      resolveCandidates({
        requestedModel: 'gateway/auto',
        allowed,
        explicitModels: ['secret/model'],
      }),
    ).toThrow(/None of the models listed in gateway\.models/);
  });

  it('returns model_not_found for an unknown reference', () => {
    try {
      resolveCandidates({ requestedModel: 'nope/nope', allowed });
      expect.unreachable();
    } catch (err) {
      expect((err as GatewayError).type).toBe('model_not_found');
    }
  });

  it('errors when a virtual model resolves to nothing permitted', () => {
    expect(() => resolveCandidates({ requestedModel: 'gateway/auto', allowed: [] })).toThrow(
      /no permitted models/,
    );
  });
});
