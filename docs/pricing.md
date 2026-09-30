# Pricing

## Pricing is configuration, not knowledge

The gateway does not know what models cost. It applies a price table an operator
configured, and says so everywhere a cost appears.

This matters because a cost figure that looks authoritative but is wrong is
worse than no figure at all — people make budget and routing decisions with it.

## The shipped table is explicitly unverified

A fresh install has a complete, working cost pipeline out of the box using
placeholder numbers. They are not verified against any provider's published
pricing, and the gateway never pretends otherwise:

- the boot banner warns
- `GET /` reports `pricing.verified: false` with a note
- `/v1/models` returns the version, its age, and each price's source
- the dashboard shows an `unverified pricing` badge in the top bar and a warning
  on the Models page
- `aigw models list` prints the warning
- every usage response carries a `disclosure` block

Replace them before treating any cost as real.

## Publishing a verified table

```bash
curl -X POST $GATEWAY_URL/api/v1/pricing/versions \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{
    "version": "2026-09",
    "asOf": "2026-09-28",
    "source": "checked against provider price pages 2026-09-28 by alice",
    "prices": {
      "openai/gpt-4o-mini": {
        "inputPerMillionTokens": 0.15,
        "outputPerMillionTokens": 0.6,
        "cachedInputPerMillionTokens": 0.075,
        "currency": "USD"
      }
    }
  }'
```

`source` is free text and should say who checked what, when. It is shown in the
dashboard next to the version.

## Versions are immutable

Every cost row records the pricing version it was computed with. Publishing a
new table changes what _future_ requests cost; it never rewrites history.

That is the property that makes "why did last month cost that?" answerable: the
numbers behind an old invoice are still there, tied to the table that produced
them.

```
request req_01J…  cost 0.000312  pricingVersion "2026-08"
request req_01K…  cost 0.000287  pricingVersion "2026-09"
```

A usage summary spanning a price change lists every version it touched, so a
figure is never silently a blend of two price tables.

## Staleness

`PricingBook.ageInDays()` is surfaced next to every cost figure. A table last
verified 200 days ago is reported as such rather than presented as current.

## Cost calculation

```
inputCost  = (freshInput × inputRate + cachedInput × cachedRate) / 1_000_000
outputCost = (outputTokens × outputRate) / 1_000_000
```

Provider-cached prompt tokens are billed at the cached rate when the provider
reports them and the table defines one; otherwise they fall back to the standard
input rate rather than being assumed free.

Rounded to 8 decimals, because per-request costs are routinely measured in
micro-currency and rounding them to cents would round most of them to zero.

## Unpriced models

A model with no configured price records **no cost**, rather than a guessed one.
It is reported as `unpriced` in the dashboard and CLI, and `lowest_cost` ranks
it **last** — not knowing what something costs is not the same as it being free.

## Estimated versus reported tokens

Cost accuracy has two independent parts.

1. **The token counts.** `usage.source` is `provider_reported` when the provider
   gave them and `estimated` when the gateway approximated them. Estimates come
   from a characters-per-token heuristic, not a tokenizer, and are labelled as
   estimates wherever they surface.
2. **The price table.** Discussed above.

The dashboard reports the share of requests in a window whose counts were
estimated, so you can tell how much of a cost figure rests on approximation.

## Self-hosted models

Self-hosted inference has no per-token vendor price, so the seed table prices
those at zero. Operators who want amortized hardware cost attributed per token
can publish a snapshot that overrides those zeros — the mechanism is the same.
