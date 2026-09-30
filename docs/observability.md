# Observability

Three layers, each answering a different question.

| Layer     | Question                                                  | Scope                 |
| --------- | --------------------------------------------------------- | --------------------- |
| Trace     | "Why did _this_ request do that?"                         | One request           |
| Metrics   | "What is the system doing right now?"                     | Aggregate, real-time  |
| Analytics | "What happened over the last week, and what did it cost?" | Aggregate, historical |

## Request traces

Every request gets a ULID (`req_01J…`) that sorts chronologically, so the
request table can be range-scanned by id without a secondary timestamp index.

A trace records every pipeline stage with its duration and status, every
provider attempt with the backoff that preceded it, and the reasons behind the
routing decision — captured at decision time, not reconstructed afterwards:

```
✓ request_received      <1ms
✓ authentication        <1ms   apiKeyPrefix=aigw_live_a1b2c3
✓ rate_limit            <1ms   rulesEvaluated=4
✓ policy_evaluation     <1ms   permittedModels=6 adjustments=["max_tokens lowered…"]
✓ budget_check          <1ms   projectedCost=0.00031
– cache_lookup          <1ms   Caching is disabled by policy.
✓ routing                1ms   strategy=highest_reliability chain=[…] rejected=[…]
✗ provider_request       6ms   provider_error  provider=mock model=mock/mock-flaky
✗ provider_request       6ms   provider_error
✓ provider_request       6ms   provider=mock model=mock/mock-fast
✓ usage_extraction      <1ms   source=provider_reported
✓ response_sent         <1ms   httpStatus=200
```

Retrieve with `GET /api/v1/requests/:id`, `aigw request get REQUEST_ID`, or the
dashboard.

### Gateway overhead

A trace separates total latency from time spent inside provider calls:

```
total latency      418ms
provider time       25ms
gateway overhead   393ms   ← retry backoff dominates here
```

"The gateway added 2ms" and "the model took 900ms" are different facts and only
one is the gateway's responsibility. Note that retry backoff counts as gateway
overhead, because it is latency the gateway chose to add.

## Metrics

Prometheus exposition at `/metrics`, unauthenticated and free of tenant data.

```
aigw_requests_total{status,provider,model}
aigw_request_duration_ms_bucket{provider,model,le}
aigw_provider_attempts_total{provider,outcome,errorType}
aigw_provider_duration_ms_bucket{provider,model,le}
aigw_time_to_first_token_ms_bucket{provider,model,le}
aigw_tokens_total{direction,source}
aigw_estimated_cost_total{currency}
aigw_cache_lookups_total{result}
aigw_fallbacks_total{from,to}
aigw_rate_limited_total{rule}
aigw_budget_blocks_total{action}
aigw_circuit_state{target}              0 closed, 1 half-open, 2 open
aigw_provider_health{provider}          1 healthy, 0.75 unknown, 0.5 degraded, 0 unavailable
aigw_gateway_overhead_ms_bucket{provider,le}
```

Note `aigw_tokens_total{source}` — it distinguishes provider-reported from
estimated tokens, so a dashboard can show how much of a figure rests on
approximation.

Latency buckets are sized for LLM traffic (10ms → 120s), not web traffic.

### Alerts worth having

```promql
# Error rate above 5% over five minutes
sum(rate(aigw_requests_total{status="error"}[5m]))
  / sum(rate(aigw_requests_total[5m])) > 0.05

# A circuit has opened
max(aigw_circuit_state) >= 2

# Gateway overhead above 50ms at p95 — the gateway's own problem, not a model's
histogram_quantile(0.95, sum(rate(aigw_gateway_overhead_ms_bucket[5m])) by (le)) > 50

# Fallback rate climbing: a provider is degrading before it fails outright
sum(rate(aigw_fallbacks_total[15m])) / sum(rate(aigw_requests_total[15m])) > 0.05
```

## Logs

Structured JSON, one object per line, with **mandatory redaction**. A logger
that trusts its callers to sanitize is a logger that eventually leaks.

```json
{
  "level": "warn",
  "time": "2026-09-30T04:06:16.932Z",
  "msg": "retrying upstream",
  "requestId": "req_01J…",
  "provider": "openai",
  "model": "openai/gpt-4o-mini",
  "errorType": "provider_rate_limit",
  "delayMs": 1240,
  "attempt": 2
}
```

`LOG_PRETTY=true` for human-readable development output.

## Provider health

Measured from this gateway's own traffic over a rolling window — success rate,
error rate, timeout rate, rate-limit rate, p50/p95/p99 — never vendor-published
availability.

```bash
curl $GATEWAY_URL/health/providers
```

The background worker also probes each provider on a timer and records
snapshots, and emits `provider.degraded` / `provider.recovered` webhooks on
genuine state transitions only — a provider that is still degraded should not
page anyone every thirty seconds.

## Analytics

```bash
curl "$GATEWAY_URL/api/v1/usage?range=7d" -H "Authorization: Bearer $KEY"
```

Every figure comes from recorded request rows. Test traffic is excluded by
default, and every response carries a disclosure block:

```json
{
  "disclosure": {
    "pricingVersion": "2026-09",
    "pricingAgeDays": 2,
    "estimatedUsageShare": 0.04,
    "note": "Costs are computed from the configured price table, not from provider invoices. …"
  }
}
```

### Provider comparison

`GET /api/v1/usage/providers` reports measurements with their time range:
request count, success rate, error rate, latency percentiles, tokens, estimated
cost, cost per million tokens, and the reported/estimated usage mix.

There is deliberately no composite score and no ranking of model quality. The
gateway shows measurements and lets an operator draw the conclusion.

## Health endpoints

| Endpoint   | Meaning                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz` | Liveness — is the process up?                                                                                                                                            |
| `/readyz`  | Readiness — can this replica serve? Reports `degraded` with **no providers registered**, because a gateway that is up but has nothing to route to will 503 every request |
| `/metrics` | Prometheus scrape                                                                                                                                                        |
| `/`        | Self-description: version, providers, model count, store kind, counter durability, pricing version and whether it is verified                                            |
