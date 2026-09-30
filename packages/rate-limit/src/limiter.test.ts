import { describe, expect, it } from 'vitest';
import { FakeClock } from '@ai-gateway/core';
import { MemoryKV } from '@ai-gateway/cache';
import { RateLimiter, defaultRules } from './limiter.js';
import { rateLimitHeaders, type RateLimitContext, type RateLimitRule } from './types.js';

const ctx: RateLimitContext = {
  organizationId: 'org_1',
  projectId: 'proj_1',
  apiKeyId: 'key_1',
  modelId: 'mock/mock-fast',
  providerId: 'mock',
};

function setup(clockStart = 0) {
  const clock = new FakeClock(clockStart);
  const kv = new MemoryKV(() => clock.now());
  return { clock, limiter: new RateLimiter({ kv, clock }), kv };
}

const rpm = (limit: number): RateLimitRule => ({ id: 'rpm', subject: 'api_key', unit: 'requests', window: 'minute', limit });
const tpm = (limit: number): RateLimitRule => ({ id: 'tpm', subject: 'api_key', unit: 'tokens', window: 'minute', limit });

describe('RateLimiter - request limits', () => {
  it('allows up to the limit and rejects the next request', async () => {
    const { limiter } = setup();
    const rules = [rpm(3)];
    for (let i = 0; i < 3; i++) {
      expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    }
    const blocked = await limiter.check(rules, ctx);
    expect(blocked.allowed).toBe(false);
    expect(blocked.violated?.id).toBe('rpm');
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('slides rather than resetting at a fixed boundary', async () => {
    const { clock, limiter } = setup();
    const rules = [rpm(2)];
    await limiter.check(rules, ctx);
    await clock.advance(30_000);
    await limiter.check(rules, ctx);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);

    // 31s later the first timestamp leaves the window and one slot frees up.
    await clock.advance(31_000);
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);
  });

  it('isolates counters per subject', async () => {
    const { limiter } = setup();
    const rules = [rpm(1)];
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);
    expect((await limiter.check(rules, { ...ctx, apiKeyId: 'key_2' })).allowed).toBe(true);
  });

  it('scopes model limits per organization so tenants cannot starve each other', async () => {
    const { limiter } = setup();
    const rules: RateLimitRule[] = [{ id: 'm', subject: 'model', unit: 'requests', window: 'minute', limit: 1, target: 'mock/mock-fast' }];
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);
    expect((await limiter.check(rules, { ...ctx, organizationId: 'org_2' })).allowed).toBe(true);
  });

  it('applies a targeted model rule only to that model', async () => {
    const { limiter } = setup();
    const rules: RateLimitRule[] = [{ id: 'm', subject: 'model', unit: 'requests', window: 'minute', limit: 1, target: 'mock/mock-smart' }];
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    const smart = { ...ctx, modelId: 'mock/mock-smart' };
    expect((await limiter.check(rules, smart)).allowed).toBe(true);
    expect((await limiter.check(rules, smart)).allowed).toBe(false);
  });

  it('does not consume quota on rules that passed when a later rule rejects', async () => {
    const { limiter } = setup();
    const rules: RateLimitRule[] = [
      { id: 'org', subject: 'organization', unit: 'requests', window: 'minute', limit: 100 },
      { id: 'key', subject: 'api_key', unit: 'requests', window: 'minute', limit: 1 },
    ];
    await limiter.check(rules, ctx);
    const blocked = await limiter.check(rules, ctx);
    expect(blocked.allowed).toBe(false);

    const orgState = (await limiter.peek(rules, ctx)).find((r) => r.rule.id === 'org');
    expect(orgState?.used).toBe(1);
  });

  it('skips user-subject rules when no end user is attributed', async () => {
    const { limiter } = setup();
    const rules: RateLimitRule[] = [{ id: 'u', subject: 'user', unit: 'requests', window: 'minute', limit: 1 }];
    const check = await limiter.check(rules, ctx);
    expect(check.results).toHaveLength(0);
    expect(check.allowed).toBe(true);

    const withUser = { ...ctx, userId: 'user_9' };
    expect((await limiter.check(rules, withUser)).allowed).toBe(true);
    expect((await limiter.check(rules, withUser)).allowed).toBe(false);
  });

  it('enforces several windows at once', async () => {
    const { clock, limiter } = setup();
    const rules: RateLimitRule[] = [
      { id: 'rpm', subject: 'api_key', unit: 'requests', window: 'minute', limit: 10 },
      { id: 'rph', subject: 'api_key', unit: 'requests', window: 'hour', limit: 12 },
    ];
    for (let i = 0; i < 10; i++) expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);

    await clock.advance(61_000);
    // Minute window cleared, but only 2 of the hourly budget remain.
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);
  });
});

describe('RateLimiter - token limits', () => {
  it('rejects when the estimate would exceed the token budget', async () => {
    const { limiter } = setup();
    const rules = [tpm(1_000)];
    await limiter.settle(rules, ctx, 900);
    expect((await limiter.check(rules, ctx, 50)).allowed).toBe(true);
    expect((await limiter.check(rules, ctx, 500)).allowed).toBe(false);
  });

  it('settles against the provider-reported count, not the estimate', async () => {
    const { limiter } = setup();
    const rules = [tpm(1_000)];
    await limiter.check(rules, ctx, 100);
    // Estimated 100, actually used 400.
    await limiter.settle(rules, ctx, 400);
    expect((await limiter.peek(rules, ctx))[0]?.used).toBe(400);
  });

  it('ignores a zero or negative settlement', async () => {
    const { limiter } = setup();
    const rules = [tpm(1_000)];
    await limiter.settle(rules, ctx, 0);
    await limiter.settle(rules, ctx, -5);
    expect((await limiter.peek(rules, ctx))[0]?.used).toBe(0);
  });
});

describe('rate limit headers', () => {
  it('emits limit, remaining and reset for both units', async () => {
    const { limiter } = setup(1_700_000_000_000);
    const rules = [rpm(10), tpm(1_000)];
    const check = await limiter.check(rules, ctx, 10);
    const headers = rateLimitHeaders(check);
    expect(headers['x-ratelimit-limit-requests']).toBe('10');
    // Reported after this request is counted, so a client can pace itself.
    expect(headers['x-ratelimit-remaining-requests']).toBe('9');
    expect(headers['x-ratelimit-limit-tokens']).toBe('1000');
    expect(Number(headers['x-ratelimit-reset-requests'])).toBeGreaterThan(1_700_000_000);
  });

  it('includes retry-after only when a rule was violated', async () => {
    const { limiter } = setup();
    const rules = [rpm(1)];
    expect(rateLimitHeaders(await limiter.check(rules, ctx))['retry-after']).toBeUndefined();
    expect(rateLimitHeaders(await limiter.check(rules, ctx))['retry-after']).toBeDefined();
  });

  it('never reports negative remaining', async () => {
    const { limiter } = setup();
    const rules = [tpm(100)];
    await limiter.settle(rules, ctx, 500);
    const headers = rateLimitHeaders(await limiter.check(rules, ctx, 1));
    expect(headers['x-ratelimit-remaining-tokens']).toBe('0');
  });
});

describe('defaults and reset', () => {
  it('ships four starting rules covering both units at key and org scope', () => {
    const rules = defaultRules();
    expect(rules.map((r) => `${r.subject}:${r.unit}:${r.window}`)).toEqual([
      'api_key:requests:minute',
      'api_key:tokens:minute',
      'organization:requests:hour',
      'organization:tokens:day',
    ]);
  });

  it('supports an operator reset', async () => {
    const { limiter } = setup();
    const rules = [rpm(1)];
    await limiter.check(rules, ctx);
    expect((await limiter.check(rules, ctx)).allowed).toBe(false);
    await limiter.reset(rules, ctx);
    expect((await limiter.check(rules, ctx)).allowed).toBe(true);
  });
});
