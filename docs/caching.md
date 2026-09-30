# Caching

## Off by default, and why

A gateway that silently caches model output changes application behaviour
nobody asked for. For anything non-deterministic or personalised that is a bug,
not an optimisation. So `cache.mode` defaults to `off` and caching is something
an operator turns on deliberately, per policy.

## Two caches

**Exact** hashes every field that can change the completion — messages,
temperature, top_p, max_tokens, stop, n, penalties, seed, tools, tool_choice,
response_format — and serves a byte-identical repeat. Omitting one of those
would serve a response the caller did not ask for, which is worse than a miss.

Fields that cannot change the output (`user`, `metadata`, `gateway.tags`) are
deliberately excluded, so tagging a request does not defeat the cache.

**Semantic** embeds the conversation text and serves a near-match above a
similarity floor. Sampling parameters do not participate in the similarity
comparison — two prompts differing only in temperature are the same question —
but they are re-checked on hit, so a semantic hit never ignores a parameter the
caller set.

## Tenant isolation is structural

The organization id is part of the cache key and of the semantic index key. Two
organizations sending byte-identical prompts cannot see each other's
completions, and a similarity search cannot reach another tenant's entries even
if the embedding is identical. This is asserted by end-to-end tests, not just
by construction.

## What a request can ask for

```jsonc
{
  "gateway": {
    "cache": "no-store", // never read, never write. Always honoured.
    "cacheSimilarityThreshold": 0.98, // tighten the floor for this request
  },
}
```

`no-store` is honoured unconditionally: a caller who says a request is not
cacheable knows something the gateway does not. A request can _narrow_ caching
(`exact-only`) but never enable it where policy disabled it.

A policy can also exclude by tag:

```yaml
cache:
  mode: exact
  excludeTags: [pii, user-specific]
```

## Configuration

```yaml
cache:
  mode: off # off | exact | semantic
  ttlSeconds: 3600
  similarityThreshold: 0.95
  crossModel: false # allow a hit produced by another model in the family
  perProject: true # scope per project rather than per organization
```

The validator warns when `similarityThreshold` is below 0.8 on a semantic cache,
because below that you will serve answers to questions nobody asked.

## Cost accounting for a hit

A cache hit records a cost of **zero** and keeps the original producer's
attribution:

```jsonc
{
  "cache": "exact_hit",
  "provider": "anthropic",
  "model": "anthropic/claude-haiku-4",
  "reasons": ["served from exact cache", "originally produced by anthropic/claude-haiku-4"],
  "estimatedCost": { "amount": 0, "currency": "USD" },
}
```

A cached answer did not call a provider. Charging for it would inflate spend,
and crediting the provider with a request it never served would corrupt the
provider comparison.

## Streaming

Cached responses are replayed as well-formed streams, so a streaming client
needs no separate code path for hits. Streaming responses are cached by
buffering a copy of the assembled text as it is forwarded — the forwarding
itself is still incremental.

## The semantic index, honestly

The built-in implementation is a bounded brute-force cosine scan —
`maxEntriesPerScope` defaults to 500, so a lookup is a few hundred dot products,
which is cheap next to a model call.

It is not a vector database. Deployments needing more should implement the
`VectorIndex` seam against pgvector or Redis Search. The current implementation
is honest about its ceiling rather than pretending to scale.

Semantic caching also requires an embedding model:

```bash
SEMANTIC_CACHE_EMBEDDING_MODEL=openai/text-embedding-3-small
```

If that model is not registered or does not support embeddings, semantic caching
stays **off** and the gateway logs why. Silently degrading to "enabled but never
hits" would be worse than leaving it off.

## When not to enable it

- Anything with per-user personalisation in the prompt
- Anything where the same question should get a fresh answer (creative work,
  sampling at high temperature)
- Anything where staleness is a correctness problem rather than a cost problem

Exact caching is safe far more often than semantic caching. Reach for semantic
only when you have measured the hit rate you would get and are comfortable with
the similarity floor.
