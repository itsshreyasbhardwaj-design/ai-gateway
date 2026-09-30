# Retries, fallback and circuit breaking

Three mechanisms with three different jobs:

- **Retry** — the same target, when the error says trying again might work
- **Fallback** — a different target, when the error says a different provider
  might work
- **Circuit breaking** — stop sending to a target that keeps failing

## What is retried

Only errors whose type is marked retryable:

```
provider_timeout  provider_unavailable  provider_overloaded
provider_error    provider_rate_limit
```

Never retried: `invalid_request`, `authentication_error`, `permission_denied`,
`model_not_allowed`, `policy_violation`, `budget_exceeded`, `content_filter`,
`context_length_exceeded`, `capability_unsupported`.

Retrying those cannot succeed. At gateway scale, doing it anyway is how a
provider's rate limits get exhausted by traffic that was always going to fail.

## Backoff

```yaml
retry:
  maxAttempts: 3 # attempts against a single target
  initialDelayMs: 250
  maxDelayMs: 8000
  backoff: exponential # exponential | linear | constant
  factor: 2
  jitter: full # none | full | equal
  respectRetryAfter: true
```

Full jitter is the default because it is what actually breaks up retry storms.
Without it, every client that failed at the same moment retries at the same
moment; `jitter: none` is available and the policy validator warns about it.

When a provider sends `Retry-After`, that is believed even if it exceeds
`maxDelayMs` — it knows something the gateway does not — with a small jitter on
top so a fleet of gateways does not resume in lockstep.

## Fallback

When a target exhausts its retries and the error is failoverable, the next
target in the chain is tried. A non-failoverable error aborts the whole chain
immediately: walking a fallback chain with a malformed request just multiplies
the failure across providers.

Client disconnection stops everything at once. There is no one left to receive
the response, so continuing would spend money for nobody.

```
attempt 1  mock/mock-flaky → provider_error   6ms
attempt 2  mock/mock-flaky → provider_error   6ms   (waited 86ms)
attempt 3  mock/mock-flaky → provider_error   7ms   (waited 305ms)
attempt 4  mock/mock-fast  → success          6ms
```

Every attempt is on the trace, with the backoff that preceded it.

### When everything fails

With more than one target, the caller gets `fallback_exhausted` (502) naming the
chain and the last error type.

With a _single_ target, the caller gets the provider's own normalized error —
status code, `retryable`, `Retry-After` and all. There was no fallback to
exhaust, and reporting `fallback_exhausted` would hide the actual cause.

## Circuit breaking

States: `CLOSED` → `OPEN` → `HALF_OPEN` → `CLOSED`.

```ts
{
  failureThreshold: 5,        // consecutive failures that trip it
  minimumThroughput: 10,      // calls before a failure *rate* is trusted
  failureRateThreshold: 0.5,  // rate that trips it once throughput is met
  rollingWindowMs: 60_000,
  openDurationMs: 30_000,
  halfOpenProbes: 2,
  successThreshold: 2,        // consecutive probe successes to close
}
```

**A single failed request never removes a provider from rotation.** Tripping
needs either a run of consecutive failures or a sustained failure _rate_ over a
minimum call volume. Below that volume a rate is noise, not signal.

Recovery is probe-based, not time-based alone: after the open period, a bounded
number of probes are admitted, and a failed probe re-opens immediately rather
than letting a still-sick provider take full traffic again.

Breakers are per provider _and_ model, so one bad model does not take down its
siblings. An open circuit removes a target from the current request's
candidates; it never disables the provider.

Operators can reset breakers from the dashboard, the API, or after fixing a
credential:

```bash
curl -X POST $GATEWAY_URL/api/v1/playground/reset-circuits -H "Authorization: Bearer $ADMIN_KEY"
```

## Health-aware routing

Health is measured from this gateway's own traffic over a rolling window:
success rate, error rate, timeout rate, rate-limit rate, and latency
percentiles.

| State         | Meaning                            | Effect on routing                  |
| ------------- | ---------------------------------- | ---------------------------------- |
| `healthy`     | At or above the success-rate floor | Normal                             |
| `degraded`    | Below the floor but usable         | Score ×0.7                         |
| `unavailable` | Well below the floor               | Excluded                           |
| `unknown`     | Too few samples to judge           | Treated as unproven, not unhealthy |

That last row matters: penalising a provider for having no history would mean
a newly added provider never gets traffic and therefore never builds history.

## Verifying it yourself

```bash
node --import tsx examples/fallback.ts
```

Induces a real failure on the synthetic provider, shows the retries and the
failover, then lets it recover. The behaviour is also covered by 14 end-to-end
tests in `tests/e2e/failure.test.ts`, one per failure mode.
