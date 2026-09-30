import type { ChatRequest } from '@ai-gateway/core';

export type CacheMode = 'off' | 'exact' | 'semantic';

export interface CachePolicy {
  mode: CacheMode;
  ttlSeconds: number;
  similarityThreshold: number;
  /** Allow a hit produced by a different model in the same family. */
  crossModel: boolean;
  /** Scope entries to the project instead of the whole organization. */
  perProject: boolean;
  /** Never cache a request carrying one of these tags. */
  excludeTags?: string[];
}

/**
 * Caching is opt-in.
 *
 * The default is `off`: a gateway that silently caches model output changes
 * application behaviour in ways the developer did not ask for, and for some
 * workloads (anything non-deterministic or personalised) that is a bug, not an
 * optimisation.
 */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  mode: 'off',
  ttlSeconds: 3_600,
  similarityThreshold: 0.95,
  crossModel: false,
  perProject: true,
};

export type CacheDecision =
  | { read: false; write: false; reason: string; status: 'disabled' | 'bypass' }
  | {
      read: true;
      write: true;
      mode: Exclude<CacheMode, 'off'>;
      threshold: number;
      ttlSeconds: number;
    };

/** Narrowing helper, so callers do not have to re-derive the union arm. */
export type EnabledCacheDecision = Extract<CacheDecision, { read: true }>;

/**
 * Decide whether this specific request may read from, and write to, the cache.
 *
 * `gateway.cache: "no-store"` is honoured unconditionally, because a caller who
 * says a request is not cacheable knows something the gateway does not.
 */
export function decideCache(policy: CachePolicy, request: ChatRequest): CacheDecision {
  const directive = request.gateway?.cache;

  if (directive === 'no-store') {
    return {
      read: false,
      write: false,
      reason: 'Request set gateway.cache=no-store.',
      status: 'bypass',
    };
  }

  const tags = request.gateway?.tags ?? [];
  const excluded = policy.excludeTags?.find((t) => tags.includes(t));
  if (excluded) {
    return {
      read: false,
      write: false,
      reason: `Request tagged "${excluded}", which the cache policy excludes.`,
      status: 'bypass',
    };
  }

  // Streaming responses are cached: the gateway buffers a copy as it forwards
  // chunks, and replays cached hits as a synthetic stream.
  let mode: CacheMode = policy.mode;
  if (directive === 'exact-only') mode = 'exact';
  if (directive === 'semantic') mode = policy.mode === 'off' ? 'off' : 'semantic';

  if (mode === 'off') {
    return {
      read: false,
      write: false,
      reason: 'Caching is disabled by policy.',
      status: 'disabled',
    };
  }

  const threshold = request.gateway?.cacheSimilarityThreshold ?? policy.similarityThreshold;
  return { read: true, write: true, mode, threshold, ttlSeconds: policy.ttlSeconds };
}

/** Model scope for a cache key, honouring the cross-model setting. */
export function modelScopeFor(policy: CachePolicy, modelId: string, family?: string): string {
  return policy.crossModel && family ? `family:${family}` : modelId;
}
