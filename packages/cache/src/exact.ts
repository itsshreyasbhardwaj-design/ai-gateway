import type { ChatResponse, MeasuredUsage } from '@ai-gateway/core';
import type { KeyValueStore } from './kv.js';
import { exactCacheKey, type CacheScope } from './key.js';
import type { ChatRequest } from '@ai-gateway/core';

export interface CachedCompletion {
  response: ChatResponse;
  storedAt: number;
  /** Provider/model that originally produced this response. */
  producedBy: { providerId: string; modelId: string };
  usage?: MeasuredUsage;
  /** Pricing version in force when the original cost was recorded. */
  pricingVersion?: string;
}

export interface CacheReadResult {
  hit: boolean;
  entry?: CachedCompletion;
  key: string;
}

/**
 * Byte-exact request cache.
 *
 * A hit means the same organization already asked this exact question with the
 * same parameters. The served response keeps the original `producedBy`
 * attribution so analytics never credit a cached answer to a provider call
 * that did not happen.
 */
export class ExactCache {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly defaultTtlSeconds = 3_600,
  ) {}

  async lookup(scope: CacheScope, request: ChatRequest): Promise<CacheReadResult> {
    const key = exactCacheKey(scope, request);
    const raw = await this.kv.get(key);
    if (!raw) return { hit: false, key };
    try {
      return { hit: true, entry: JSON.parse(raw) as CachedCompletion, key };
    } catch {
      // A corrupt entry is a miss, not an error.
      await this.kv.del(key);
      return { hit: false, key };
    }
  }

  async store(
    scope: CacheScope,
    request: ChatRequest,
    entry: CachedCompletion,
    ttlSeconds = this.defaultTtlSeconds,
  ): Promise<string> {
    const key = exactCacheKey(scope, request);
    await this.kv.set(key, JSON.stringify(entry), ttlSeconds);
    return key;
  }

  async invalidate(scope: CacheScope): Promise<number> {
    const keys = await this.kv.keys(`cache:exact:${scope.organizationId}:`);
    return keys.length ? this.kv.del(...keys) : 0;
  }
}
