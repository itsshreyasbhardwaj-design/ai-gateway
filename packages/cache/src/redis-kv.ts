import type { KeyValueStore } from './kv.js';

/**
 * Redis-backed store.
 *
 * `ioredis` is imported lazily so a deployment that never configures Redis
 * neither loads nor pays for it. Everything here is either a single command or
 * a Lua script, so counters stay correct across gateway replicas.
 */

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incrby(key: string, amount: number): Promise<number>;
  incrbyfloat(key: string, amount: number): Promise<string>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  zcard(key: string): Promise<number>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

/** Increment and set a TTL only if the key is new, so windows do not slide. */
const INCR_WITH_TTL = `
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) and tonumber(ARGV[2]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return current
`;

const INCRFLOAT_WITH_TTL = `
local current = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 and tonumber(ARGV[2]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return current
`;

export class RedisKV implements KeyValueStore {
  private constructor(private readonly redis: RedisLike) {}

  static async connect(url: string, options: Record<string, unknown> = {}): Promise<RedisKV> {
    const { default: Redis } = (await import('ioredis')) as unknown as {
      default: new (url: string, opts?: Record<string, unknown>) => RedisLike;
    };
    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
      ...options,
    });
    return new RedisKV(client);
  }

  /** For tests or callers holding their own client. */
  static wrap(client: RedisLike): RedisKV {
    return new RedisKV(client);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) await this.redis.set(key, value, 'EX', ttlSeconds);
    else await this.redis.set(key, value);
  }

  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const result =
      ttlSeconds !== undefined
        ? await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')
        : await this.redis.set(key, value, 'NX');
    return result === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const result = await this.redis.eval(INCR_WITH_TTL, 1, key, amount, ttlSeconds ?? 0);
    return Number(result);
  }

  async incrByFloat(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const result = await this.redis.eval(INCRFLOAT_WITH_TTL, 1, key, amount, ttlSeconds ?? 0);
    return Number(result);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  /** SCAN rather than KEYS: this must never block a shared Redis. */
  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      out.push(...batch);
    } while (cursor !== '0');
    return out;
  }

  async zadd(key: string, score: number, member: string, ttlSeconds?: number): Promise<void> {
    await this.redis.zadd(key, score, member);
    if (ttlSeconds !== undefined) await this.redis.expire(key, ttlSeconds);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    return this.redis.zremrangebyscore(key, min, max);
  }

  async zcard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  async listPush(key: string, value: string, maxLength: number, ttlSeconds?: number): Promise<void> {
    await this.redis.lpush(key, value);
    await this.redis.ltrim(key, 0, maxLength - 1);
    if (ttlSeconds !== undefined) await this.redis.expire(key, ttlSeconds);
  }

  async listRange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/**
 * Wraps a store so a backing-service outage degrades the gateway rather than
 * breaking it.
 *
 * Caching and counters are best-effort by design: if Redis is down, requests
 * should still reach the model. The one thing that must NOT fail open is a
 * limit that protects spend - callers that enforce budgets pass
 * `failOpen: false` and get the error, so a Redis outage cannot be used to
 * bypass a budget.
 */
export class ResilientKV implements KeyValueStore {
  private consecutiveFailures = 0;

  constructor(
    private readonly inner: KeyValueStore,
    private readonly onError?: (op: string, err: unknown) => void,
  ) {}

  get degraded(): boolean {
    return this.consecutiveFailures > 0;
  }

  private async guard<T>(op: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      this.onError?.(op, err);
      return fallback;
    }
  }

  get = (key: string) => this.guard('get', () => this.inner.get(key), null);
  set = (key: string, value: string, ttl?: number) =>
    this.guard('set', () => this.inner.set(key, value, ttl), undefined);
  setIfAbsent = (key: string, value: string, ttl?: number) =>
    this.guard('setIfAbsent', () => this.inner.setIfAbsent(key, value, ttl), true);
  del = (...keys: string[]) => this.guard('del', () => this.inner.del(...keys), 0);
  incrBy = (key: string, amount: number, ttl?: number) =>
    this.guard('incrBy', () => this.inner.incrBy(key, amount, ttl), amount);
  incrByFloat = (key: string, amount: number, ttl?: number) =>
    this.guard('incrByFloat', () => this.inner.incrByFloat(key, amount, ttl), amount);
  expire = (key: string, ttl: number) => this.guard('expire', () => this.inner.expire(key, ttl), undefined);
  ttl = (key: string) => this.guard('ttl', () => this.inner.ttl(key), -2);
  keys = (prefix: string) => this.guard('keys', () => this.inner.keys(prefix), []);
  zadd = (key: string, score: number, member: string, ttl?: number) =>
    this.guard('zadd', () => this.inner.zadd(key, score, member, ttl), undefined);
  zremrangebyscore = (key: string, min: number, max: number) =>
    this.guard('zremrangebyscore', () => this.inner.zremrangebyscore(key, min, max), 0);
  zcard = (key: string) => this.guard('zcard', () => this.inner.zcard(key), 0);
  listPush = (key: string, value: string, maxLength: number, ttl?: number) =>
    this.guard('listPush', () => this.inner.listPush(key, value, maxLength, ttl), undefined);
  listRange = (key: string, start: number, stop: number) =>
    this.guard('listRange', () => this.inner.listRange(key, start, stop), []);
  ping = () => this.guard('ping', () => this.inner.ping(), false);
  close = () => this.inner.close();

  /** Escape hatch for call sites that must see the real error. */
  get raw(): KeyValueStore {
    return this.inner;
  }
}
