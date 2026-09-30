import { healthScore } from '@ai-gateway/observability';
import type { RoutingStrategy, ScoredTarget } from './types.js';

/**
 * Each strategy returns a score in [0, 1]; higher is better. Scores are
 * comparable across strategies only in the sense that the router always sorts
 * descending - the *meaning* of the number is strategy-specific, which is why
 * every scored target also carries a human-readable reason.
 */
export type ScoreFn = (
  target: ScoredTarget,
  all: ScoredTarget[],
  cursor: number,
) => { score: number; reason: string };

/** Cheapest projected cost wins. Unpriced targets sort last, not first. */
const lowestCost: ScoreFn = (target, all) => {
  const costs = all.map((t) => t.signals.projectedCost).filter((c): c is number => c !== undefined);
  const cost = target.signals.projectedCost;
  if (cost === undefined) {
    return {
      score: 0,
      reason: 'no pricing configured for this model, ranked last under lowest_cost',
    };
  }
  const max = Math.max(...costs, 0);
  const min = Math.min(...costs);
  if (max === min)
    return { score: 1, reason: `projected cost ${cost.toFixed(6)} (all candidates equal)` };
  return {
    score: 1 - (cost - min) / (max - min),
    reason: `lowest projected cost among candidates (${cost.toFixed(6)})`,
  };
};

/** Lowest observed p95. A target with no history is treated as unproven-but-usable. */
const lowestLatency: ScoreFn = (target, all) => {
  const p95 = target.signals.p95LatencyMs;
  if (
    p95 === undefined ||
    target.signals.health === undefined ||
    target.signals.health.successes === 0
  ) {
    return { score: 0.5, reason: 'no measured latency yet, ranked mid-pack' };
  }
  const measured = all
    .map((t) => t.signals.p95LatencyMs)
    .filter((v): v is number => v !== undefined && v > 0);
  const max = Math.max(...measured, 1);
  const min = Math.min(...measured);
  if (max === min) return { score: 1, reason: `p95 ${Math.round(p95)}ms (all candidates equal)` };
  return {
    score: 1 - (p95 - min) / (max - min),
    reason: `lowest measured p95 latency (${Math.round(p95)}ms over the health window)`,
  };
};

/** Highest measured success rate, blended with the health state. */
const highestReliability: ScoreFn = (target) => {
  const stats = target.signals.health;
  const state = healthScore(target.signals.healthState);
  if (!stats || stats.total === 0) {
    return { score: state * 0.75, reason: 'no request history yet, using health state only' };
  }
  const score = stats.successRate * 0.7 + state * 0.3;
  return {
    score,
    reason: `measured success rate ${(stats.successRate * 100).toFixed(1)}% over ${stats.total} requests`,
  };
};

/** Proportional share. Deterministic given the cursor, so plans are reproducible. */
const weighted: ScoreFn = (target, all, cursor) => {
  const total = all.reduce((sum, t) => sum + (t.target.weight ?? 1), 0);
  const weight = target.target.weight ?? 1;
  const share = total > 0 ? weight / total : 0;

  // Deterministically pick one winner per cursor value, weighted by share.
  const pick = (cursor % 1000) / 1000;
  let cumulative = 0;
  let selected = all[0]?.target.modelId;
  for (const candidate of all) {
    cumulative += (candidate.target.weight ?? 1) / (total || 1);
    if (pick < cumulative) {
      selected = candidate.target.modelId;
      break;
    }
  }

  const chosen = selected === target.target.modelId;
  return {
    score: chosen ? 1 : share,
    reason: chosen
      ? `selected by weighted draw (weight ${weight} of ${total})`
      : `weight ${weight} of ${total} (${(share * 100).toFixed(0)}% share)`,
  };
};

/** Explicit operator ordering. Lower priority number wins. */
const priority: ScoreFn = (target, all) => {
  const priorities = all.map((t) => t.target.priority ?? 100);
  const value = target.target.priority ?? 100;
  const max = Math.max(...priorities);
  const min = Math.min(...priorities);
  if (max === min) return { score: 1, reason: `priority ${value} (all candidates equal)` };
  return { score: 1 - (value - min) / (max - min), reason: `operator priority ${value}` };
};

/** Even distribution by position. */
const roundRobin: ScoreFn = (target, all, cursor) => {
  const index = all.findIndex(
    (t) =>
      t.target.modelId === target.target.modelId &&
      t.target.providerId === target.target.providerId,
  );
  const chosen = all.length > 0 && index === cursor % all.length;
  return {
    score: chosen ? 1 : 0.5 - index / (all.length * 2),
    reason: chosen
      ? `round-robin position ${index} selected for cursor ${cursor}`
      : `round-robin position ${index}`,
  };
};

/** Preserve the order the policy declared. */
const declaredOrder: ScoreFn = (target, all) => {
  const index = all.findIndex(
    (t) =>
      t.target.modelId === target.target.modelId &&
      t.target.providerId === target.target.providerId,
  );
  return {
    score: all.length > 1 ? 1 - index / all.length : 1,
    reason:
      index === 0
        ? 'first entry in the configured chain'
        : `position ${index} in the configured chain`,
  };
};

export const SCORERS: Record<RoutingStrategy, ScoreFn> = {
  explicit: declaredOrder,
  fallback_chain: declaredOrder,
  lowest_cost: lowestCost,
  lowest_latency: lowestLatency,
  highest_reliability: highestReliability,
  weighted,
  priority,
  round_robin: roundRobin,
};
