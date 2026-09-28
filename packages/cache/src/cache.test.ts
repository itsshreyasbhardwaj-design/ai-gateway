import { describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResponse } from '@ai-gateway/core';
import { MemoryKV } from './kv.js';
import { ResilientKV } from './redis-kv.js';
import { ExactCache, type CachedCompletion } from './exact.js';
import { SemanticCache, cosineSimilarity } from './semantic.js';
import { exactCacheKey, stableStringify, semanticText, parameterFingerprint } from './key.js';
import { DEFAULT_CACHE_POLICY, decideCache, modelScopeFor } from './policy.js';

const orgA = { organizationId: 'org_a', modelScope: 'mock/mock-fast' };
const orgB = { organizationId: 'org_b', modelScope: 'mock/mock-fast' };

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'mock/mock-fast',
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  ...over,
});

const response: ChatResponse = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'mock/mock-fast',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Paris' }, finish_reason: 'stop' }],
};

const entry: CachedCompletion = {
  response,
  storedAt: Date.now(),
  producedBy: { providerId: 'mock', modelId: 'mock/mock-fast' },
};

describe('cache keys', () => {
  it('is stable regardless of JSON key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('differs across organizations for an identical prompt', () => {
    expect(exactCacheKey(orgA, request())).not.toBe(exactCacheKey(orgB, request()));
  });

  it('differs when any output-affecting parameter changes', () => {
    const base = exactCacheKey(orgA, request());
    expect(exactCacheKey(orgA, request({ temperature: 0.7 }))).not.toBe(base);
    expect(exactCacheKey(orgA, request({ max_tokens: 10 }))).not.toBe(base);
    expect(exactCacheKey(orgA, request({ seed: 1 }))).not.toBe(base);
    expect(exactCacheKey(orgA, request({ response_format: { type: 'json_object' } }))).not.toBe(base);
    expect(
      exactCacheKey(orgA, request({ tools: [{ type: 'function', function: { name: 'f' } }] })),
    ).not.toBe(base);
  });

  it('ignores fields that cannot change the completion', () => {
    const base = exactCacheKey(orgA, request());
    expect(exactCacheKey(orgA, request({ user: 'alice' }))).toBe(base);
    expect(exactCacheKey(orgA, request({ metadata: { trace: 'x' } }))).toBe(base);
    expect(exactCacheKey(orgA, request({ gateway: { tags: ['x'] } }))).toBe(base);
  });

  it('builds semantic text from conversation content only', () => {
    expect(semanticText(request())).toBe('user: What is the capital of France?');
    expect(semanticText(request({ temperature: 0.9 }))).toBe(semanticText(request()));
  });

  it('fingerprints parameters separately from messages', () => {
    expect(parameterFingerprint(request())).toBe(parameterFingerprint(request({ messages: [{ role: 'user', content: 'different' }] })));
    expect(parameterFingerprint(request())).not.toBe(parameterFingerprint(request({ temperature: 1 })));
  });
});

describe('ExactCache', () => {
  it('misses, stores, then hits', async () => {
    const cache = new ExactCache(new MemoryKV());
    expect((await cache.lookup(orgA, request())).hit).toBe(false);
    await cache.store(orgA, request(), entry);
    const hit = await cache.lookup(orgA, request());
    expect(hit.hit).toBe(true);
    expect(hit.entry?.response.choices[0]?.message.content).toBe('Paris');
    expect(hit.entry?.producedBy.providerId).toBe('mock');
  });

  it('never serves one organization an entry stored by another', async () => {
    const cache = new ExactCache(new MemoryKV());
    await cache.store(orgA, request(), entry);
    expect((await cache.lookup(orgB, request())).hit).toBe(false);
  });

  it('expires entries', async () => {
    let now = 0;
    const cache = new ExactCache(new MemoryKV(() => now));
    await cache.store(orgA, request(), entry, 10);
    expect((await cache.lookup(orgA, request())).hit).toBe(true);
    now = 11_000;
    expect((await cache.lookup(orgA, request())).hit).toBe(false);
  });

  it('treats a corrupt entry as a miss and evicts it', async () => {
    const kv = new MemoryKV();
    const cache = new ExactCache(kv);
    await kv.set(exactCacheKey(orgA, request()), '{not json');
    expect((await cache.lookup(orgA, request())).hit).toBe(false);
    expect(await kv.get(exactCacheKey(orgA, request()))).toBeNull();
  });

  it('invalidates only the requested organization', async () => {
    const cache = new ExactCache(new MemoryKV());
    await cache.store(orgA, request(), entry);
    await cache.store(orgB, request(), entry);
    await cache.invalidate(orgA);
    expect((await cache.lookup(orgA, request())).hit).toBe(false);
    expect((await cache.lookup(orgB, request())).hit).toBe(true);
  });
});

describe('SemanticCache', () => {
  /** Toy embedding: unit vector over a small fixed vocabulary. */
  const embed = async (text: string): Promise<number[]> => {
    const vocab = ['capital', 'france', 'paris', 'weather', 'pune', 'python', 'recursion'];
    const lowered = text.toLowerCase();
    const vector = vocab.map((word) => (lowered.includes(word) ? 1 : 0));
    const norm = Math.hypot(...vector) || 1;
    return vector.map((v) => v / norm);
  };

  it('returns a hit for a semantically equivalent prompt', async () => {
    const cache = new SemanticCache(new MemoryKV(), embed, { similarityThreshold: 0.8 });
    await cache.store(orgA, request({ messages: [{ role: 'user', content: 'What is the capital of France?' }] }), entry);
    const hit = await cache.lookup(orgA, request({ messages: [{ role: 'user', content: 'france capital please' }] }));
    expect(hit).not.toBeNull();
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.8);
    expect(hit!.entry.response.choices[0]?.message.content).toBe('Paris');
  });

  it('misses for an unrelated prompt', async () => {
    const cache = new SemanticCache(new MemoryKV(), embed, { similarityThreshold: 0.8 });
    await cache.store(orgA, request(), entry);
    expect(await cache.lookup(orgA, request({ messages: [{ role: 'user', content: 'explain recursion in python' }] }))).toBeNull();
  });

  it('never crosses organization boundaries', async () => {
    const kv = new MemoryKV();
    const cacheA = new SemanticCache(kv, embed, { similarityThreshold: 0.5 });
    await cacheA.store(orgA, request(), entry);
    expect(await cacheA.lookup(orgB, request())).toBeNull();
  });

  it('refuses a hit when sampling parameters differ', async () => {
    const cache = new SemanticCache(new MemoryKV(), embed, { similarityThreshold: 0.5 });
    await cache.store(orgA, request({ temperature: 0 }), entry);
    expect(await cache.lookup(orgA, request({ temperature: 1 }))).toBeNull();
    expect(await cache.lookup(orgA, request({ temperature: 0 }))).not.toBeNull();
  });

  it('honours a per-request threshold override', async () => {
    const cache = new SemanticCache(new MemoryKV(), embed, { similarityThreshold: 0.99 });
    await cache.store(orgA, request(), entry);
    // Overlaps on capital+france but adds a third term, so cosine is ~0.82.
    const near = request({ messages: [{ role: 'user', content: 'is paris the capital of france' }] });
    expect(await cache.lookup(orgA, near, 0.5)).not.toBeNull();
    expect(await cache.lookup(orgA, near)).toBeNull();
  });

  it('picks the closest of several candidates', async () => {
    const cache = new SemanticCache(new MemoryKV(), embed, { similarityThreshold: 0.1 });
    await cache.store(orgA, request({ messages: [{ role: 'user', content: 'weather in pune' }] }), {
      ...entry,
      response: { ...response, choices: [{ index: 0, message: { role: 'assistant', content: 'Warm' }, finish_reason: 'stop' }] },
    });
    await cache.store(orgA, request({ messages: [{ role: 'user', content: 'capital of france' }] }), entry);
    const hit = await cache.lookup(orgA, request({ messages: [{ role: 'user', content: 'the capital of france' }] }));
    expect(hit!.entry.response.choices[0]?.message.content).toBe('Paris');
  });

  it('bounds the index size per scope', async () => {
    const cache = new SemanticCache(new MemoryKV(), embed, { maxEntriesPerScope: 3, similarityThreshold: 0.9 });
    for (let i = 0; i < 10; i++) {
      await cache.store(orgA, request({ messages: [{ role: 'user', content: `prompt ${i}` }] }), entry);
    }
    expect(await cache.size(orgA)).toBe(3);
  });

  it('does not store prompt previews unless asked', async () => {
    const kv = new MemoryKV();
    const cache = new SemanticCache(kv, embed);
    await cache.store(orgA, request(), entry);
    const [stored] = await kv.listRange('cache:semantic:org_a:*:mock/mock-fast', 0, -1);
    expect(stored).not.toContain('capital of France');
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is 0 rather than NaN for degenerate input', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('cache policy', () => {
  it('is off by default', () => {
    const decision = decideCache(DEFAULT_CACHE_POLICY, request());
    expect(decision.read).toBe(false);
    expect(decision.write).toBe(false);
  });

  it('honours no-store even when caching is enabled', () => {
    const policy = { ...DEFAULT_CACHE_POLICY, mode: 'semantic' as const };
    const decision = decideCache(policy, request({ gateway: { cache: 'no-store' } }));
    expect(decision.read).toBe(false);
    expect(decision.write).toBe(false);
    expect('status' in decision && decision.status).toBe('bypass');
  });

  it('lets a request narrow semantic caching to exact-only', () => {
    const policy = { ...DEFAULT_CACHE_POLICY, mode: 'semantic' as const };
    const decision = decideCache(policy, request({ gateway: { cache: 'exact-only' } }));
    expect('mode' in decision && decision.mode).toBe('exact');
  });

  it('never lets a request enable caching the policy disabled', () => {
    const decision = decideCache(DEFAULT_CACHE_POLICY, request({ gateway: { cache: 'semantic' } }));
    expect(decision.read).toBe(false);
  });

  it('excludes tagged requests', () => {
    const policy = { ...DEFAULT_CACHE_POLICY, mode: 'exact' as const, excludeTags: ['pii'] };
    expect(decideCache(policy, request({ gateway: { tags: ['pii'] } })).read).toBe(false);
    expect(decideCache(policy, request({ gateway: { tags: ['batch'] } })).read).toBe(true);
  });

  it('scopes by family only when cross-model reuse is enabled', () => {
    expect(modelScopeFor(DEFAULT_CACHE_POLICY, 'openai/gpt-4o', 'gpt')).toBe('openai/gpt-4o');
    expect(modelScopeFor({ ...DEFAULT_CACHE_POLICY, crossModel: true }, 'openai/gpt-4o', 'gpt')).toBe('family:gpt');
  });
});

describe('MemoryKV', () => {
  it('supports counters with TTL that does not slide on increment', async () => {
    let now = 0;
    const kv = new MemoryKV(() => now);
    expect(await kv.incrBy('c', 1, 10)).toBe(1);
    now = 5_000;
    expect(await kv.incrBy('c', 1, 10)).toBe(2);
    now = 10_001;
    expect(await kv.incrBy('c', 1, 10)).toBe(1);
  });

  it('implements setIfAbsent as a lock primitive', async () => {
    const kv = new MemoryKV();
    expect(await kv.setIfAbsent('lock', '1', 30)).toBe(true);
    expect(await kv.setIfAbsent('lock', '1', 30)).toBe(false);
    await kv.del('lock');
    expect(await kv.setIfAbsent('lock', '1', 30)).toBe(true);
  });

  it('reports ttl semantics like Redis', async () => {
    const kv = new MemoryKV();
    expect(await kv.ttl('missing')).toBe(-2);
    await kv.set('forever', 'x');
    expect(await kv.ttl('forever')).toBe(-1);
    await kv.set('ephemeral', 'x', 30);
    expect(await kv.ttl('ephemeral')).toBeGreaterThan(0);
  });
});

describe('ResilientKV', () => {
  const broken = (): MemoryKV => {
    const kv = new MemoryKV();
    for (const op of ['get', 'set', 'incrBy'] as const) {
      (kv as unknown as Record<string, unknown>)[op] = async () => {
        throw new Error('redis down');
      };
    }
    return kv;
  };

  it('degrades to a miss when the backing store is down', async () => {
    const errors: string[] = [];
    const kv = new ResilientKV(broken(), (op) => errors.push(op));
    expect(await kv.get('k')).toBeNull();
    expect(kv.degraded).toBe(true);
    expect(errors).toContain('get');
  });

  it('never silently under-counts a limit', async () => {
    // A failed increment reports the amount requested rather than 0, so a
    // counter outage cannot be used to appear under a limit.
    const kv = new ResilientKV(broken());
    expect(await kv.incrBy('c', 5)).toBe(5);
  });
});
