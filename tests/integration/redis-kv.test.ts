import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisKV, type KeyValueStore } from '@ai-gateway/cache';
import { RateLimiter } from '@ai-gateway/rate-limit';
import { SpendCounters } from '@ai-gateway/usage';

/**
 * Redis-backed counters against a real Redis.
 *
 * The in-memory store passes the same tests, but only real Redis exercises the
 * Lua scripts, the sorted-set operations and the TTL semantics that make
 * counters correct across gateway replicas. Those are the properties that fail
 * silently — a limiter that quietly allows 3x its limit across three replicas
 * looks fine until the provider bill arrives.
 */

const REDIS_URL = process.env['REDIS_URL'];
const describeIfRedis = REDIS_URL ? describe : describe.skip;

describeIfRedis('RedisKV', () => {
  let kv: KeyValueStore;
  const prefix = `test:${Date.now()}:`;

  beforeAll(async () => {
    kv = await RedisKV.connect(REDIS_URL!);
  }, 30_000);

  afterAll(async () => {
    const keys = await kv?.keys(prefix);
    if (keys?.length) await kv.del(...keys);
    await kv?.close();
  });

  it('connects and responds', async () => {
    expect(await kv.ping()).toBe(true);
  });

  it('round-trips a value with a TTL', async () => {
    await kv.set(`${prefix}value`, 'hello', 60);
    expect(await kv.get(`${prefix}value`)).toBe('hello');
    expect(await kv.ttl(`${prefix}value`)).toBeGreaterThan(0);
    expect(await kv.ttl(`${prefix}missing`)).toBe(-2);
  });

  it('increments atomically without sliding the TTL', async () => {
    const key = `${prefix}counter`;
    expect(await kv.incrBy(key, 1, 60)).toBe(1);
    const firstTtl = await kv.ttl(key);

    expect(await kv.incrBy(key, 1, 60)).toBe(2);
    expect(await kv.incrBy(key, 5, 60)).toBe(7);

    // The Lua script sets the TTL only when the key is new; otherwise a busy
    // counter would keep pushing its own expiry out and never reset.
    expect(await kv.ttl(key)).toBeLessThanOrEqual(firstTtl);
  });

  it('increments floats for spend counters', async () => {
    const key = `${prefix}spend`;
    await kv.incrByFloat(key, 0.000123, 60);
    await kv.incrByFloat(key, 0.000877, 60);
    expect(Number(await kv.get(key))).toBeCloseTo(0.001, 6);
  });

  it('implements setIfAbsent as a lock primitive', async () => {
    const key = `${prefix}lock`;
    expect(await kv.setIfAbsent(key, '1', 30)).toBe(true);
    expect(await kv.setIfAbsent(key, '1', 30)).toBe(false);
    await kv.del(key);
    expect(await kv.setIfAbsent(key, '1', 30)).toBe(true);
  });

  it('supports the sorted-set operations the sliding window needs', async () => {
    const key = `${prefix}window`;
    const now = Date.now();
    for (let i = 0; i < 5; i++) await kv.zadd(key, now - i * 1000, `member-${i}`, 60);

    expect(await kv.zcard(key)).toBe(5);
    // Trim everything older than 2.5s, as the limiter does on every check.
    expect(await kv.zremrangebyscore(key, 0, now - 2_500)).toBe(2);
    expect(await kv.zcard(key)).toBe(3);
  });

  it('scans rather than blocking on KEYS', async () => {
    for (let i = 0; i < 5; i++) await kv.set(`${prefix}scan:${i}`, String(i), 60);
    const found = await kv.keys(`${prefix}scan:`);
    expect(found).toHaveLength(5);
  });

  it('caps a list, for the semantic cache index', async () => {
    const key = `${prefix}list`;
    for (let i = 0; i < 10; i++) await kv.listPush(key, `entry-${i}`, 3, 60);
    const entries = await kv.listRange(key, 0, -1);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toBe('entry-9');
  });
});

describeIfRedis('distributed counters', () => {
  let kv: KeyValueStore;
  const suffix = Date.now();

  beforeAll(async () => {
    kv = await RedisKV.connect(REDIS_URL!);
  }, 30_000);

  afterAll(async () => {
    for (const p of [`rl:`, `spend:`]) {
      const keys = await kv?.keys(p);
      if (keys?.length) await kv.del(...keys);
    }
    await kv?.close();
  });

  it('shares a rate limit across separate limiter instances', async () => {
    // Two RateLimiter instances stand in for two gateway replicas: the whole
    // point of Redis here is that they agree.
    const replicaA = new RateLimiter({ kv });
    const replicaB = new RateLimiter({ kv });

    const rules = [
      {
        id: `shared-${suffix}`,
        subject: 'api_key' as const,
        unit: 'requests' as const,
        window: 'minute' as const,
        limit: 3,
      },
    ];
    const ctx = {
      organizationId: `org_${suffix}`,
      projectId: `proj_${suffix}`,
      apiKeyId: `key_${suffix}`,
    };

    expect((await replicaA.check(rules, ctx)).allowed).toBe(true);
    expect((await replicaB.check(rules, ctx)).allowed).toBe(true);
    expect((await replicaA.check(rules, ctx)).allowed).toBe(true);

    // Fourth request against a limit of three, whichever replica sees it.
    expect((await replicaB.check(rules, ctx)).allowed).toBe(false);
  });

  it('shares spend counters across instances', async () => {
    const counterA = new SpendCounters(kv, `spend`);
    const counterB = new SpendCounters(kv, `spend`);
    const ctx = {
      organizationId: `org_spend_${suffix}`,
      projectId: `proj_${suffix}`,
      apiKeyId: `key_${suffix}`,
    };

    await counterA.record(ctx, 1.25);
    await counterB.record(ctx, 2.75);

    expect(
      await counterB.read(ctx.organizationId, 'organization', ctx.organizationId, 'monthly'),
    ).toBeCloseTo(4, 6);
  });

  it('settles token limits against the reported usage, not the estimate', async () => {
    const limiter = new RateLimiter({ kv });
    const rules = [
      {
        id: `tokens-${suffix}`,
        subject: 'api_key' as const,
        unit: 'tokens' as const,
        window: 'minute' as const,
        limit: 1_000,
      },
    ];
    const ctx = {
      organizationId: `org_tok_${suffix}`,
      projectId: `proj_${suffix}`,
      apiKeyId: `key_tok_${suffix}`,
    };

    await limiter.check(rules, ctx, 100);
    await limiter.settle(rules, ctx, 400);

    const state = await limiter.peek(rules, ctx);
    expect(state[0]?.used).toBe(400);
  });
});
