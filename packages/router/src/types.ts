import type {
  ChatRequest,
  ModelCapability,
  ModelDescriptor,
  ProviderHealthState,
} from '@ai-gateway/core';
import type { HealthStats } from '@ai-gateway/observability';
import type { CircuitState } from '@ai-gateway/observability';

/**
 * Routing strategies.
 *
 * Note what is deliberately absent: there is no "best model" or "highest
 * quality" strategy. The gateway measures latency, cost, and its own observed
 * success rate. It does not rank model output quality, because it has no
 * defensible way to measure that.
 */
export type RoutingStrategy =
  | 'explicit'
  | 'lowest_cost'
  | 'lowest_latency'
  | 'highest_reliability'
  | 'weighted'
  | 'priority'
  | 'round_robin'
  | 'fallback_chain';

export const ROUTING_STRATEGIES: RoutingStrategy[] = [
  'explicit',
  'lowest_cost',
  'lowest_latency',
  'highest_reliability',
  'weighted',
  'priority',
  'round_robin',
  'fallback_chain',
];

export function isRoutingStrategy(value: string): value is RoutingStrategy {
  return (ROUTING_STRATEGIES as string[]).includes(value);
}

/** One routable provider+model pair. */
export interface RouteTarget {
  providerId: string;
  modelId: string;
  model: ModelDescriptor;
  /** Weighted strategy share. Defaults to 1. */
  weight?: number;
  /** Priority strategy ordering. Lower wins. Defaults to 100. */
  priority?: number;
}

export interface TargetSignals {
  health: HealthStats | undefined;
  healthState: ProviderHealthState;
  circuit: CircuitState;
  /** Projected cost of this request on this target, in the org currency. */
  projectedCost?: number;
  /** Observed p95 latency in ms, from this gateway's own traffic. */
  p95LatencyMs?: number;
  successRate?: number;
}

export interface ScoredTarget {
  target: RouteTarget;
  signals: TargetSignals;
  score: number;
  reasons: string[];
}

export interface RejectedTarget {
  target: string;
  reason: string;
}

export interface RoutePlan {
  strategy: RoutingStrategy;
  /** Ordered attempt sequence: index 0 is primary, the rest are fallbacks. */
  chain: ScoredTarget[];
  rejected: RejectedTarget[];
  /** Human-readable explanation of why the primary was chosen. */
  reasons: string[];
}

export interface RouteInput {
  request: ChatRequest;
  /** Candidates after allowlist/policy filtering, in policy order. */
  candidates: RouteTarget[];
  strategy: RoutingStrategy;
  /** Capabilities the request needs, derived from its shape. */
  requiredCapabilities: ModelCapability[];
  signals: (target: RouteTarget) => TargetSignals;
  /** Max targets in the returned chain, including the primary. */
  maxChainLength?: number;
  /** Disable fallback entirely; the chain will hold at most one target. */
  fallbackEnabled?: boolean;
  /** Remaining budget in the org currency. Targets projected over it are skipped. */
  remainingBudget?: number;
  /** Round-robin cursor, so the caller owns the counter across requests. */
  roundRobinCursor?: number;
}

/** Work out what the request actually needs from a model. */
export function requiredCapabilities(request: ChatRequest): ModelCapability[] {
  const needed: ModelCapability[] = ['chat'];
  if (request.stream) needed.push('streaming');
  if (request.tools?.length || request.tool_choice) needed.push('tools');
  if (request.response_format?.type === 'json_schema') needed.push('structured-output');
  else if (request.response_format?.type === 'json_object') needed.push('json-mode');
  const hasImage = request.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  );
  if (hasImage) needed.push('vision');
  return needed;
}
