/**
 * Key/value abstraction shared by caching, rate limiting, usage counters and
 * distributed locks.
 *
 * Two implementations ship: an in-process map (so `pnpm dev` needs no Redis)
 * and Redis (so more than one gateway replica agrees on counters). Everything
 * upstream of this interface is storage-agnostic.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Returns false when the key already exists. Used for locks. */
  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  del(...keys: string[]): Promise<number>;
  /** Atomic increment returning the new value. Creates the key at 0 first. */
  incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number>;
  /** Atomic float increment, for cost counters. */
  incrByFloat(key: string, amount: number, ttlSeconds?: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
  keys(prefix: string): Promise<string[]>;
  /** Sorted-set helpers backing the sliding-window rate limiter. */
  zadd(key: string, score: number, member: string, ttlSeconds?: number): Promise<void>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  /** Push onto a capped list, used by the brute-force vector index. */
  listPush(key: string, value: string, maxLength: number, ttlSeconds?: number): Promise<void>;
  listRange(key: string, start: number, stop: number): Promise<string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt?: number;
}

/**
 * In-process store.
 *
 * Correct for a single replica and for tests. Counters are not shared across
 * processes, so the gateway logs a warning at boot when it is used with more
 * than one replica configured - see `docs/rate-limits.md`.
 */
export class MemoryKV implements KeyValueStore {
  private map = new Map<string, Entry>();
  private zsets = new Map<string, Map<string, number>>();
  private lists = new Map<string, string[]>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private alive(key: string): Entry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.map.set(key, {
      value,
      ...(ttlSeconds !== undefined ? { expiresAt: this.now() + ttlSeconds * 1000 } : {}),
    });
  }

  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (this.alive(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.map.delete(key)) removed++;
      this.zsets.delete(key);
      this.lists.delete(key);
    }
    return removed;
  }

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const current = Number(this.alive(key)?.value ?? '0');
    const next = current + amount;
    const existing = this.alive(key);
    this.map.set(key, {
      value: String(next),
      ...(existing?.expiresAt !== undefined
        ? { expiresAt: existing.expiresAt }
        : ttlSeconds !== undefined
          ? { expiresAt: this.now() + ttlSeconds * 1000 }
          : {}),
    });
    return next;
  }

  async incrByFloat(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    return this.incrBy(key, amount, ttlSeconds);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.alive(key);
    if (entry) entry.expiresAt = this.now() + ttlSeconds * 1000;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.alive(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix) && this.alive(key)) out.push(key);
    }
    return out;
  }

  async zadd(key: string, score: number, member: string, ttlSeconds?: number): Promise<void> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.zsets.set(key, set);
    if (ttlSeconds !== undefined) {
      this.map.set(`${key}::ttl`, { value: '1', expiresAt: this.now() + ttlSeconds * 1000 });
    }
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of set) {
      if (score >= min && score <= max) {
        set.delete(member);
        removed++;
      }
    }
    if (set.size === 0) this.zsets.delete(key);
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async listPush(key: string, value: string, maxLength: number, _ttlSeconds?: number): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    if (list.length > maxLength) list.length = maxLength;
    this.lists.set(key, list);
  }

  async listRange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.map.clear();
    this.zsets.clear();
    this.lists.clear();
  }

  /** Test helper. */
  get size(): number {
    return this.map.size;
  }
}
