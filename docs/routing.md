# Routing

## What the router will and will not claim

It uses three measurable things: the projected cost of this request under the
configured price table, the latency this gateway has measured, and the success
rate this gateway has measured.

It does not rank model quality. There is no "best model" strategy and no
composite score, because the gateway has no defensible way to measure output
quality and a number that looked authoritative would be worse than no number.

## Strategies

| Strategy              | Picks                                                  | Uses                          |
| --------------------- | ------------------------------------------------------ | ----------------------------- |
| `explicit`            | The order declared in the policy                       | Nothing measured              |
| `fallback_chain`      | Same as explicit; reads better when that is the intent | —                             |
| `lowest_cost`         | Cheapest projected cost                                | Price table + prompt estimate |
| `lowest_latency`      | Lowest measured p95                                    | This gateway's own traffic    |
| `highest_reliability` | Highest measured success rate                          | This gateway's own traffic    |
| `weighted`            | Proportional draw                                      | Declared weights              |
| `priority`            | Lowest priority number                                 | Declared priorities           |
| `round_robin`         | Even distribution                                      | A cursor                      |

Two details that matter:

- **`lowest_cost` ranks unpriced models last, not first.** A model with no
  configured price is not free; the gateway simply does not know what it costs.
- **`lowest_latency` treats an unmeasured target as mid-pack.** Ranking it best
  would send all traffic to whatever was added most recently.

## Virtual models

| Model                   | Resolves to           |
| ----------------------- | --------------------- |
| `gateway/auto`          | `highest_reliability` |
| `gateway/cheapest`      | `lowest_cost`         |
| `gateway/fastest`       | `lowest_latency`      |
| `gateway/most-reliable` | `highest_reliability` |

An exact reference like `openai/gpt-4o-mini` is attempted first, with the
policy's chain behind it as fallback. Asking for a specific model means it is
tried first — never that it is silently replaced.

## How a route is decided

**1. Eligibility.** Each candidate is filtered, and every exclusion is recorded
with its reason:

- missing a required capability (derived from the request: `stream` needs
  `streaming`, `tools` needs `tools`, an image part needs `vision`, a
  `json_schema` response format needs `structured-output`)
- model status `disabled`
- circuit breaker `OPEN`
- measured health `unavailable`
- projected cost above the remaining budget

**2. Scoring.** The strategy scores each eligible target in `[0, 1]`, then
penalties apply:

| Condition               | Multiplier |
| ----------------------- | ---------- |
| measured `degraded`     | ×0.7       |
| circuit `HALF_OPEN`     | ×0.5       |
| model marked `degraded` | ×0.8       |
| model `deprecated`      | ×0.9       |

A degraded provider stays routable but sorts behind healthy ones, so it drains
rather than being cut off abruptly.

**3. Ordering.** Sorted by score, ties broken on declared order, so a plan is
deterministic for identical input. The top `fallback.maxTargets` become the
chain.

Under `explicit`, the operator's ordering is the intent: a degraded target is
demoted but not overtaken, because the caller asked for it by name.

## The plan

```jsonc
{
  "strategy": "highest_reliability",
  "chain": [
    {
      "target": "anthropic/claude-haiku-4",
      "score": 0.994,
      "reasons": ["measured success rate 99.8% over 2104 requests"],
    },
    {
      "target": "openai/gpt-4o-mini",
      "score": 0.981,
      "reasons": ["measured success rate 98.4% over 1877 requests"],
    },
  ],
  "rejected": [
    {
      "target": "google/gemini-2.0-flash",
      "reason": "circuit breaker is open after repeated failures",
    },
    {
      "target": "openai/text-embedding-3-small",
      "reason": "does not support required capability: chat",
    },
  ],
  "reasons": ["strategy: highest_reliability", "…", "2 of 4 candidates eligible"],
}
```

The whole thing is on the request trace and in the `gateway` object on the
response.

## Trying it without spending anything

```bash
curl -X POST $GATEWAY_URL/api/v1/playground/route-test \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model": "gateway/auto", "prompt": "Explain this SQL query.", "strategy": "lowest_cost"}'
```

No provider is contacted and nothing is billed. It reports which target would be
chosen, the fallback chain behind it, and every excluded candidate with its
reason. The dashboard's Playground and `aigw routing test` both call it.

Note that a dry run deliberately does not advance the round-robin cursor that
live traffic uses.

## Per-request overrides

```jsonc
{
  "model": "gateway/auto",
  "messages": [/* … */],
  "gateway": {
    "strategy": "lowest_cost",
    "models": ["openai/gpt-4o-mini", "anthropic/claude-haiku-4"],
    "fallback": false,
    "timeoutMs": 30000,
  },
}
```

`gateway.models` can only _narrow_ what the policy and allowlists already
permit. Listing a model the project cannot use returns `model_not_allowed`, not
a silent substitution.
