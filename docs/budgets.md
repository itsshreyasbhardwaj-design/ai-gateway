# Budgets

## What a budget can and cannot promise

It can stop the gateway dispatching a request whose projected cost would cross a
limit, using the configured price table.

It cannot promise your provider invoice matches. Spend here is computed from the
price table you configured, so a budget is exactly as accurate as that table is.
If the table is the shipped placeholder set, your budget thresholds are
illustrative too. See [pricing.md](./pricing.md).

Nothing in this system reads a provider's billing API.

## Scopes and periods

Three scopes — `organization`, `project`, `api_key` — and two periods, `daily`
and `monthly`, both in UTC so a budget does not shift with a viewer's timezone.

Budgets at different scopes stack. A project budget and an organization budget
both apply; the strictest outcome wins.

## Actions

| Action                      | Effect                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `BLOCK`                     | Refuse with `402 budget_exceeded` before any provider is contacted |
| `WARN`                      | Allow, record the overage, fire a `budget.warning` webhook         |
| `FALLBACK_TO_CHEAPER_MODEL` | Restrict routing to targets that fit inside the remaining budget   |

A `BLOCK` at **any** scope wins over a softer action at another. Precedence is
by severity, not by scope — an organization-level block is not overridden by a
project-level warn.

## Evaluated before dispatch

On the request's projected worst-case cost, from the prompt estimate and
`max_tokens`. So 50 spent of a 100 limit, with a request projected at 60, is
refused — not discovered after the money is gone.

```json
{
  "error": {
    "type": "budget_exceeded",
    "message": "The monthly organization budget of 250 USD has been reached.",
    "requestId": "req_01J…",
    "retryable": false,
    "details": {
      "scope": "organization",
      "period": "monthly",
      "limit": 250,
      "spent": 250.4,
      "currency": "USD",
      "periodEnd": "2026-10-01T00:00:00.000Z"
    }
  }
}
```

`retryable: false` — retrying a budget failure cannot help, and a client that
retried it would just generate load.

## No request-level bypass

A configured budget is never bypassed silently. No combination of
`gateway.test`, `gateway.fallback`, `gateway.cache` or strategy override gets
past it, and the end-to-end suite asserts each of those specifically.

One deliberate exception: **test traffic is not charged against budgets.**
Playground runs, failover simulations and replays are flagged `isTest` and
excluded from spend. They still count against rate limits.

## Warning thresholds

```json
{
  "scope": "organization",
  "period": "monthly",
  "limit": 500,
  "action": "BLOCK",
  "warnThreshold": 0.8
}
```

At 80% utilization a `budget.warning` webhook fires. Webhooks are queued to the
database rather than delivered inline, so a slow endpoint never adds latency to
the inference request that triggered it.

## Spend counters

Kept in the KV store rather than derived from the requests table on every call:
a budget check sits in the hot path and must not become an aggregate query. The
requests table stays the source of truth, and counters can be reconciled from it
when they disagree.

Counters carry a TTL past the period end, so a stale counter cannot outlive its
window.

Without Redis, counters are per-process — correct for one replica, wrong for
several.

## The downgrade action

`FALLBACK_TO_CHEAPER_MODEL` passes the remaining budget to the router as a
ceiling. Targets whose projected cost exceeds it are excluded, with the reason
recorded:

```json
{
  "target": "openai/gpt-4.1",
  "reason": "projected cost 0.042000 exceeds remaining budget 0.011000"
}
```

If nothing fits, the request fails with `no_route_available` rather than being
served at a price the budget forbids.

## Checking state

```bash
curl $GATEWAY_URL/api/v1/budgets -H "Authorization: Bearer $ADMIN_KEY"
```

```json
[
  {
    "budget": { "scope": "organization", "period": "monthly", "limit": 500, "action": "BLOCK" },
    "spent": 213.4412,
    "remaining": 286.5588,
    "utilization": 0.4268,
    "periodStart": "2026-09-01T00:00:00.000Z",
    "periodEnd": "2026-10-01T00:00:00.000Z"
  }
]
```

Or `aigw usage`, or the dashboard's Budgets page.
