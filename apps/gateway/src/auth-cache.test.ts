import { describe, expect, it } from 'vitest';
import { FakeClock } from '@ai-gateway/core';
import { AuthCache } from './auth-cache.js';
import type { AuthenticatedKey } from './auth.js';

const identity = (over: Partial<AuthenticatedKey> = {}): AuthenticatedKey => ({
  organizationId: 'org_1',
  projectId: 'proj_1',
  apiKeyId: 'key_1',
  scopes: ['inference.create'],
  keyName: 'test',
  prefix: 'aigw_test_abc123',
  ...over,
});

describe('AuthCache', () => {
  it('returns a cached identity within the TTL', () => {
    const clock = new FakeClock();
    const cache = new AuthCache({ ttlMs: 30_000, clock });
    cache.set('idx', identity());
    expect(cache.get('idx')?.apiKeyId).toBe('key_1');
  });

  it('expires entries so a stale credential window stays bounded', async () => {
    const clock = new FakeClock();
    const cache = new AuthCache({ ttlMs: 30_000, clock });
    cache.set('idx', identity());

    await clock.advance(29_999);
    expect(cache.get('idx')).toBeDefined();

    await clock.advance(2);
    expect(cache.get('idx')).toBeUndefined();
  });

  it('invalidates immediately on revocation, so revocation is not delayed by the TTL', () => {
    const cache = new AuthCache({ ttlMs: 30_000, clock: new FakeClock() });
    cache.set('idx', identity());
    cache.invalidateByKeyId('key_1');
    expect(cache.get('idx')).toBeUndefined();
  });

  it('invalidates every entry belonging to one key id', () => {
    const cache = new AuthCache({ ttlMs: 30_000, clock: new FakeClock() });
    cache.set('idx_a', identity({ apiKeyId: 'key_1' }));
    cache.set('idx_b', identity({ apiKeyId: 'key_1' }));
    cache.set('idx_c', identity({ apiKeyId: 'key_2' }));

    cache.invalidateByKeyId('key_1');
    expect(cache.get('idx_a')).toBeUndefined();
    expect(cache.get('idx_b')).toBeUndefined();
    expect(cache.get('idx_c')).toBeDefined();
  });

  it('is keyed by the lookup index, never by the plaintext key', () => {
    const cache = new AuthCache({ clock: new FakeClock() });
    const plaintext = 'aigw_test_secretvalue1234567890';
    cache.set('peppered-hmac-index', identity());
    // The plaintext is not a key into the cache and nothing stores it.
    expect(cache.get(plaintext)).toBeUndefined();
    expect(JSON.stringify(cache.stats())).not.toContain(plaintext);
  });

  it('bounds its size', () => {
    const cache = new AuthCache({ maxEntries: 3, clock: new FakeClock() });
    for (let i = 0; i < 10; i++) cache.set(`idx_${i}`, identity({ apiKeyId: `key_${i}` }));
    expect(cache.stats().size).toBe(3);
    // The oldest entries were evicted, the newest retained.
    expect(cache.get('idx_0')).toBeUndefined();
    expect(cache.get('idx_9')).toBeDefined();
  });

  it('reports a hit rate so the behaviour is observable', () => {
    const cache = new AuthCache({ clock: new FakeClock() });
    cache.get('missing');
    cache.set('idx', identity());
    cache.get('idx');
    cache.get('idx');

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
  });

  it('can be cleared wholesale', () => {
    const cache = new AuthCache({ clock: new FakeClock() });
    cache.set('idx', identity());
    cache.clear();
    expect(cache.stats().size).toBe(0);
  });
});
