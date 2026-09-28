import { GatewayError, modelSupports } from '@ai-gateway/core';
import { SCORERS } from './strategies.js';
import type { RejectedTarget, RouteInput, RoutePlan, ScoredTarget } from './types.js';

const DEFAULT_CHAIN_LENGTH = 3;

/**
 * Turns a set of candidate targets into an ordered attempt chain.
 *
 * The gateway's stated principle is that routing must be explicable, so this
 * returns not just the winner but the full ranked chain, the score each target
 * got, the reason it got it, and every candidate that was excluded along with
 * why. That structure is what the request trace and the routing playground
 * both render.
 */
export function planRoute(input: RouteInput): RoutePlan {
  const rejected: RejectedTarget[] = [];
  const eligible: ScoredTarget[] = [];

  for (const target of input.candidates) {
    const label = `${target.providerId}/${target.model.providerModelId}`;
    const signals = input.signals(target);

    // 1. Capability gate. The router must never dispatch a request that needs a
    //    capability the model does not have - the provider would reject it and
    //    the caller would pay a round trip to find out.
    const missing = input.requiredCapabilities.filter((cap) => !modelSupports(target.model, cap));
    if (missing.length > 0) {
      rejected.push({ target: label, reason: `does not support required capability: ${missing.join(', ')}` });
      continue;
    }

    // 2. Model status.
    if (target.model.status === 'disabled') {
      rejected.push({ target: label, reason: 'model is disabled' });
      continue;
    }

    // 3. Circuit breaker. An open circuit removes a target from this request
    //    only; it does not disable the provider.
    if (signals.circuit === 'OPEN') {
      rejected.push({ target: label, reason: 'circuit breaker is open after repeated failures' });
      continue;
    }

    // 4. Measured health.
    if (signals.healthState === 'unavailable') {
      const rate = signals.health ? ` (success rate ${(signals.health.successRate * 100).toFixed(0)}%)` : '';
      rejected.push({ target: label, reason: `measured as unavailable${rate}` });
      continue;
    }

    // 5. Budget headroom, using the projected worst-case cost.
    if (
      input.remainingBudget !== undefined &&
      signals.projectedCost !== undefined &&
      signals.projectedCost > input.remainingBudget
    ) {
      rejected.push({
        target: label,
        reason: `projected cost ${signals.projectedCost.toFixed(6)} exceeds remaining budget ${input.remainingBudget.toFixed(6)}`,
      });
      continue;
    }

    eligible.push({ target, signals, score: 0, reasons: [] });
  }

  if (eligible.length === 0) {
    throw new GatewayError(
      'no_route_available',
      'No configured model satisfies this request.',
      { details: { rejected, strategy: input.strategy, requiredCapabilities: input.requiredCapabilities } },
    );
  }

  const scorer = SCORERS[input.strategy];
  const cursor = input.roundRobinCursor ?? 0;

  for (const candidate of eligible) {
    const { score, reason } = scorer(candidate, eligible, cursor);
    candidate.score = score;
    candidate.reasons.push(reason);

    if (candidate.signals.healthState === 'degraded') {
      // Degraded targets stay routable but sort behind healthy ones, so a
      // wobbling provider drains rather than being cut off abruptly.
      candidate.score *= 0.7;
      candidate.reasons.push('penalised: provider measured as degraded');
    }
    if (candidate.signals.circuit === 'HALF_OPEN') {
      candidate.score *= 0.5;
      candidate.reasons.push('penalised: circuit is half-open and still probing');
    }
    if (candidate.target.model.status === 'degraded') {
      candidate.score *= 0.8;
      candidate.reasons.push('penalised: model marked degraded by an operator');
    }
    if (candidate.target.model.status === 'deprecated') {
      candidate.score *= 0.9;
      candidate.reasons.push('penalised: model is deprecated');
    }
  }

  // Ties break on the declared order, so a plan is deterministic.
  const order = new Map(input.candidates.map((c, i) => [`${c.providerId}/${c.modelId}`, i]));
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ai = order.get(`${a.target.providerId}/${a.target.modelId}`) ?? 0;
    const bi = order.get(`${b.target.providerId}/${b.target.modelId}`) ?? 0;
    return ai - bi;
  });

  const maxLength = input.fallbackEnabled === false ? 1 : (input.maxChainLength ?? DEFAULT_CHAIN_LENGTH);
  const chain = eligible.slice(0, Math.max(1, maxLength));
  const primary = chain[0];

  const reasons = [
    `strategy: ${input.strategy}`,
    ...(primary?.reasons ?? []),
    `${eligible.length} of ${input.candidates.length} candidates eligible`,
  ];
  if (chain.length > 1) {
    reasons.push(`fallback chain: ${chain.slice(1).map((t) => t.target.modelId).join(' -> ')}`);
  } else if (input.fallbackEnabled === false) {
    reasons.push('fallback disabled for this request');
  }

  return { strategy: input.strategy, chain, rejected, reasons };
}

/**
 * Resolve the model a caller asked for into candidate targets.
 *
 * Handles three shapes: an explicit `provider/model` reference, a virtual
 * `gateway/*` alias, and a per-request candidate list supplied through the
 * gateway extensions.
 */
export interface ResolveInput {
  requestedModel: string;
  /** Every target the caller is permitted to use, already allowlist-filtered. */
  allowed: RouteInput['candidates'];
  /** Explicit candidates from `gateway.models`, if the caller sent any. */
  explicitModels?: string[];
  /** Default chain from the project's routing policy. */
  policyModels?: string[];
}

export interface ResolveResult {
  candidates: RouteInput['candidates'];
  /** Strategy implied by the model reference, if any. */
  impliedStrategy?: RouteInput['strategy'];
}

const VIRTUAL_STRATEGY: Record<string, RouteInput['strategy']> = {
  'gateway/auto': 'highest_reliability',
  'gateway/cheapest': 'lowest_cost',
  'gateway/fastest': 'lowest_latency',
  'gateway/most-reliable': 'highest_reliability',
};

export function resolveCandidates(input: ResolveInput): ResolveResult {
  const byId = new Map(input.allowed.map((t) => [t.modelId, t]));

  // A per-request list wins over everything else.
  if (input.explicitModels?.length) {
    const candidates = input.explicitModels
      .map((id) => byId.get(id))
      .filter((t): t is RouteInput['candidates'][number] => t !== undefined);
    if (candidates.length === 0) {
      throw new GatewayError(
        'model_not_allowed',
        'None of the models listed in gateway.models are registered and permitted for this project.',
        { details: { requested: input.explicitModels } },
      );
    }
    return { candidates };
  }

  const virtualStrategy = VIRTUAL_STRATEGY[input.requestedModel];
  if (virtualStrategy) {
    const candidates = input.policyModels?.length
      ? input.policyModels.map((id) => byId.get(id)).filter((t): t is RouteInput['candidates'][number] => t !== undefined)
      : input.allowed;
    if (candidates.length === 0) {
      throw new GatewayError(
        'no_route_available',
        `"${input.requestedModel}" resolved to no permitted models. Configure a routing policy or grant model access.`,
      );
    }
    return { candidates, impliedStrategy: virtualStrategy };
  }

  const exact = byId.get(input.requestedModel);
  if (exact) {
    // An exact reference still gets the policy's fallback chain behind it, but
    // never ahead of it: asking for a specific model means it is attempted first.
    const rest = (input.policyModels ?? [])
      .filter((id) => id !== input.requestedModel)
      .map((id) => byId.get(id))
      .filter((t): t is RouteInput['candidates'][number] => t !== undefined);
    return { candidates: [exact, ...rest], impliedStrategy: 'explicit' };
  }

  throw new GatewayError(
    'model_not_found',
    `Model "${input.requestedModel}" is not registered on this gateway, or is not permitted for this project.`,
    { details: { model: input.requestedModel } },
  );
}
