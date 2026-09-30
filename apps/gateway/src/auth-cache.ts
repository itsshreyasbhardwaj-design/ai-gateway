import { systemClock, type Clock } from '@ai-gateway/core';
import type { AuthenticatedKey } from './auth.js';

export interface AuthCacheOptions {
  /**
   * How long a successful verification is trusted, in ms.
   *
   * This is the window in which a revoked key can still be used, so it is
   * deliberately short. 30s bounds the exposure to roughly one page-refresh
   * while removing scrypt from the hot path of every subsequent request.
   */
  ttlMs?: number;
  maxEntries?: number;
  clock?: Clock;
}

interface Entry {
  identity: AuthenticatedKey;
  expiresAt: number;
}

/**
 * Short-lived cache of verified API keys.
 *
 * Why this exists: verifying a key costs one scrypt derivation, which is
 * deliberately expensive - around 40ms on a modern laptop at N=16384. That is
 * the correct cost for a stored password hash and the wrong cost to pay on
 * every single inference request; unmitigated it makes authentication the
 * dominant component of gateway latency.
 *
 * What makes it safe:
 *   - the cache key is the peppered HMAC lookup index, never the plaintext key,
 *     so a heap dump yields nothing directly usable
 *   - entries expire quickly, and revocation invalidates explicitly, so the
 *     stale-credential window is bounded and small
 *   - only *successful* verifications are cached. A failed verification is
 *     never remembered, so a wrong key costs an attacker full scrypt every time
 *     and the cache cannot be used to speed up guessing.
 */
export class AuthCache {
  private entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private hits = 0;
  private misses = 0;

  constructor(options: AuthCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? systemClock;
  }

  get(lookupIndex: string): AuthenticatedKey | undefined {
    const entry = this.entries.get(lookupIndex);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(lookupIndex);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.identity;
  }

  set(lookupIndex: string, identity: AuthenticatedKey): void {
    if (this.entries.size >= this.maxEntries) {
      // Simple FIFO eviction. Entries are short-lived, so recency-aware
      // eviction would add bookkeeping for little benefit.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(lookupIndex, { identity, expiresAt: this.clock.now() + this.ttlMs });
  }

  /** Called when a key is revoked, rotated or rescoped. */
  invalidate(lookupIndex: string): void {
    this.entries.delete(lookupIndex);
  }

  /** Called when a key id changes state but only the id is known. */
  invalidateByKeyId(apiKeyId: string): void {
    for (const [index, entry] of this.entries) {
      if (entry.identity.apiKeyId === apiKeyId) this.entries.delete(index);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number; ttlMs: number } {
    const total = this.hits + this.misses;
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      ttlMs: this.ttlMs,
    };
  }
}
