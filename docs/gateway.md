# The request pipeline

Implemented in `apps/gateway/src/pipeline/chat.ts`.

## Stage order, and why it is this order

```
request_received → authentication → rate_limit → policy_evaluation
  → budget_check → cache_lookup → routing → provider_request
  → usage_extraction → cache_write → response_sent
```

Everything that can refuse a request runs before anything that costs money.
That is not incidental: a budget checked after dispatch is a report, not a
control.

Each stage opens a trace step, and the step records its duration, its status,
and enough detail to answer "why" later. The gateway's stated contract is that
routing is never hidden, and a trace assembled after the fact from logs is not
the same thing as one recorded at decision time.

## The stages

### Authentication

A peppered HMAC of the presented key gives an O(1) lookup — not a scan that
scrypt-verifies every candidate, which at a few thousand keys would make
authentication the slowest part of the request. One scrypt verification
confirms the match.

Successful verifications are cached for 30 seconds, keyed by the HMAC. Only
successes are cached, so a guessing attacker never gets a cheaper second
attempt, and revocation and rotation invalidate explicitly. Without the cache,
scrypt dominates: p50 measured 47.77ms with it disabled and 0.37ms with it on.

Every failure — absent, malformed, unknown, revoked or expired key — returns the
same 401 with the same message. Distinguishing "no such key" from "wrong key"
tells an attacker which prefixes exist.

### Rate limiting

Sliding-window, backed by Redis when configured. Request-unit rules are consumed
here; token-unit rules are only read, because the true token count does not
exist yet. See [rate-limits.md](./rate-limits.md).

Limits come from the routing policy. A request rejected by rule 3 does not burn
quota on rules 1 and 2 — consumption happens only after every rule passes.

### Policy evaluation

Scope check, then the effective model allowlist (deny beats allow; a project can
only narrow the organization's list, never widen it), then streaming and tool
permissions, then output clamping.

When a policy lowers `max_tokens`, the adjustment is recorded on the trace:

```json
{ "adjustments": ["max_tokens lowered from 999999 to the policy ceiling of 16384"] }
```

A policy that quietly changed a request would be worse than one that refused it.

An exact model reference is checked against the allowlist _before_ the router
sees it, so a forbidden model returns `403 model_not_allowed` rather than being
replaced by a fallback. Likewise a named model that cannot serve the request —
asking an embeddings model for a completion — returns `capability_unsupported`.
The fallback chain exists for provider failures, not for a model choice that
never matched.

### Budget check

Evaluated on the request's _projected_ worst-case cost, so 50 spent of 100 with
a request projected at 60 is refused rather than discovered afterwards. A
`BLOCK` at any scope wins over a softer action at another. See
[budgets.md](./budgets.md).

### Cache lookup

Off unless a policy enables it. `gateway.cache: "no-store"` is honoured
unconditionally. A hit is served with the original producer's attribution and a
recorded cost of zero, because a cached answer did not call a provider. See
[caching.md](./caching.md).

### Routing

Returns the full ranked chain, the score and reason for each target, and every
excluded candidate with its reason. See [routing.md](./routing.md).

### Execution

Retry and failover, governed by the normalized error taxonomy. See
[fallback.md](./fallback.md).

### Usage extraction

The provider's own token counts are used when it reports them. When it does not,
the gateway estimates and labels the result `estimated` — surfaced in the
response, the trace, the analytics, the dashboard and the CLI. An estimate is
never presented as a provider-reported number.

Cost is computed from the configured price table and stamped with that table's
version, so historical spend stays reproducible after prices change.

## Streaming

Streaming forwards chunk by chunk and never buffers the response as a unit. The
only thing accumulated is the assembled text, and only when the cache is enabled
for that request.

The first chunk is pulled inside the retry boundary: a provider that fails on
connect is still failoverable, but once bytes have reached the client it is too
late to switch. After that point a failure can only be reported in-band, because
the 200 has already gone out:

```
data: {"choices":[{"delta":{"content":"partial"},...}]}

data: {"error":{"type":"provider_error","message":"…","requestId":"req_…","retryable":true}}

data: [DONE]
```

The stream always terminates with `[DONE]`, and the frame before it carries the
routing receipt. Clients written against OpenAI ignore that frame; clients that
want the routing decision get full detail without a second request.

Client disconnection aborts the upstream call. Without that, a client that hangs
up leaves the gateway paying for tokens nobody will read. Tokens already produced
before a mid-stream failure are still recorded rather than discarded, because
the provider charged for them.

## Failure recording

A failed request is recorded as thoroughly as a successful one: status, error
type, every attempt, and the trace up to the point of failure. A streaming
request that failed after headers were sent records `httpStatus: 200`, because
that is what the client actually saw; the trace carries what really happened.
