# Rate limiting

## Sliding windows, not fixed ones

A fixed window lets a caller send 2× the limit across a boundary — 600 in the
last second of one minute and 600 in the first second of the next. That is
exactly the burst a gateway in front of a metered API must not pass upstream.

The limiter keeps a sliding log of timestamps per rule, trimmed to the window on
every check.

## Two-phase token accounting

Request-unit limits are simple: check, then consume.

Token limits cannot be, because the true token count does not exist until the
model has responded. So:

1. **Check** against an estimate of the prompt size. A request that would
   obviously blow the budget is refused before dispatch.
2. **Settle** against the provider's reported usage once the response is in.

The settled number is the real one. An estimate that was 100 and turned out to
be 400 is corrected to 400, so the next check sees the truth.

## Subjects

| Subject        | Counts against                        |
| -------------- | ------------------------------------- |
| `api_key`      | One key                               |
| `user`         | The `user` field on the request       |
| `project`      | A project                             |
| `organization` | A whole organization                  |
| `model`        | One model, scoped per organization    |
| `provider`     | One provider, scoped per organization |

Model and provider limits are scoped per organization deliberately: a shared
global counter would let one tenant exhaust another's share.

## Configuration

Limits live in the routing policy:

```yaml
rateLimits:
  requestsPerMinutePerKey: 600
  tokensPerMinutePerKey: 2000000
  requestsPerHourPerOrganization: 20000
  tokensPerDayPerOrganization: 200000000
```

Declaring _any_ limit replaces the built-in default set entirely. An operator
who deliberately raises one limit should not silently inherit three others they
never configured.

## Consumption ordering

Quota is consumed only after **every** rule passes. A request rejected by rule 3
does not burn quota on rules 1 and 2 — otherwise a caller who is over one limit
would keep eroding the others while being refused.

## Response headers

Present on every response, not just 429s:

```
x-ratelimit-limit-requests: 600
x-ratelimit-remaining-requests: 597
x-ratelimit-reset-requests: 1790741520
x-ratelimit-limit-tokens: 2000000
x-ratelimit-remaining-tokens: 1997430
x-ratelimit-reset-tokens: 1790741520
retry-after: 6                      # only when a limit was hit
```

`remaining` reflects the state _after_ this request, which is what a client
pacing itself against the header expects.

`GET /v1/limits` returns current state without sending a request, so a client
can pace itself without probing for 429s. It reports the limits that actually
apply to that project, not the built-in defaults.

## Distributed correctness

With `REDIS_URL` set, counters are shared across gateway replicas via sorted
sets and Lua scripts that increment and set a TTL atomically, so a window does
not slide on every increment.

Without Redis, counters are per-process. That is correct for a single replica
and **wrong for more than one** — three replicas with a 600/min limit will
collectively allow 1800/min. The gateway says so at boot, `GET /` reports
`countersDurable: false`, and the dashboard shows a `local counters` badge.

## Degradation

Cache reads and counter operations are best-effort: a Redis outage degrades the
gateway rather than breaking it, because an inference request should still reach
the model when the counter store blips.

One exception. A failed increment reports the amount requested rather than zero,
so a counter outage can never be used to _appear_ under a limit. Failing open on
a limit that protects spend would turn an outage into a bill.

## Test traffic

Playground runs, failover simulations and replays count against rate limits.
They are exempt from budgets, but a flag that exempted a request from the
limiter would make the limiter meaningless.
