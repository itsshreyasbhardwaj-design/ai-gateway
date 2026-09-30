# HTTP API

Two surfaces: an **OpenAI-compatible inference API** under `/v1`, and an
**administrative API** under `/api/v1`. Both authenticate with the same API
keys; scopes decide what a key may do.

```
Authorization: Bearer aigw_live_…
```

## Inference

### `POST /v1/chat/completions`

Scope: `inference.create`

Accepts the OpenAI chat-completions body. Gateway-specific controls go under a
namespaced `gateway` object so no existing client parser breaks.

```jsonc
{
  "model": "gateway/auto",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1024,
  "tools": [/* … */],
  "response_format": { "type": "json_object" },

  "gateway": {
    "strategy": "lowest_cost",
    "models": ["openai/gpt-4o-mini", "anthropic/claude-haiku-4"],
    "fallback": true,
    "cache": "no-store",
    "cacheSimilarityThreshold": 0.97,
    "timeoutMs": 30000,
    "test": false,
    "tags": ["checkout-summariser"],
  },
}
```

Response adds `usage.source` and a `gateway` receipt:

```jsonc
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1790741520,
  "model": "anthropic/claude-haiku-4",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" },
  ],
  "usage": { "input": 24, "output": 118, "total": 142, "source": "provider_reported" },
  "gateway": {
    "requestId": "req_01J…",
    "provider": "anthropic",
    "model": "anthropic/claude-haiku-4",
    "strategy": "highest_reliability",
    "reasons": ["strategy: highest_reliability", "measured success rate 99.8% over 2104 requests"],
    "cache": "miss",
    "attempts": 2,
    "fallbackUsed": true,
    "rejected": [
      {
        "target": "openai/gpt-4o-mini",
        "reason": "circuit breaker is open after repeated failures",
      },
    ],
    "latencyMs": 812,
    "usageSource": "provider_reported",
    "estimatedCost": { "amount": 0.00031, "currency": "USD", "pricingVersion": "2026-09" },
  },
}
```

**Streaming** (`"stream": true`) returns `text/event-stream`. The frame before
`[DONE]` carries the routing receipt:

```
data: {"id":"req_…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"req_…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"req_…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"input":12,"output":4,"total":16,"source":"provider_reported"}}

data: {"gateway":{"requestId":"req_…","provider":"mock","model":"mock/mock-fast","attempts":1,…}}

data: [DONE]
```

A failure after headers are sent is reported in-band as an `error` frame,
because the 200 has already gone out.

### `POST /v1/responses`

Scope: `inference.create`

Accepts the same body as chat completions, recorded separately so analytics can
tell them apart. It is **not** OpenAI's stateful Responses API: a request using
`previous_response_id`, `store` or `conversation` is rejected rather than having
those fields silently ignored.

### `POST /v1/embeddings`

Scope: `inference.create`

```jsonc
{ "model": "openai/text-embedding-3-small", "input": ["first", "second"], "dimensions": 512 }
```

No fallback chain: embedding vectors from different models are not
interchangeable, so silently failing over would return vectors that do not match
your existing index.

### `GET /v1/models`

Scope: `models.read`

Returns only models this key may use, in OpenAI's shape, with extra metadata
under `gateway` including capabilities, context window and the configured price
with its version, source and as-of date.

### `GET /v1/limits`

Scope: `usage.read`

Current rate-limit state, so a client can pace itself without probing for 429s.

## Administration

All under `/api/v1`, scoped to the authenticated key's organization. Most
require `admin`.

| Method | Path                             | Scope                        | Purpose                                          |
| ------ | -------------------------------- | ---------------------------- | ------------------------------------------------ |
| GET    | `/providers`                     | admin                        | Configured providers with measured health        |
| POST   | `/providers`                     | admin                        | Register a provider (SSRF-checked)               |
| DELETE | `/providers/:id`                 | admin                        | Remove and unregister                            |
| POST   | `/providers/:id/health`          | admin                        | Probe now                                        |
| GET    | `/models`                        | models.read                  | Catalog with pricing and measured latency        |
| POST   | `/models`                        | admin                        | Register or update a model                       |
| GET    | `/pricing/versions`              | admin                        | Published price tables                           |
| POST   | `/pricing/versions`              | admin                        | Publish a new one (history is not rewritten)     |
| GET    | `/projects`                      | admin                        | List                                             |
| POST   | `/projects`                      | admin                        | Create                                           |
| PATCH  | `/projects/:id`                  | admin                        | Update allowlist, policy                         |
| GET    | `/api-keys`                      | admin                        | List (never returns secrets)                     |
| POST   | `/api-keys`                      | admin                        | Create — **secret returned once**                |
| POST   | `/api-keys/:id/rotate`           | admin                        | Replace; the old key is revoked immediately      |
| DELETE | `/api-keys/:id`                  | admin                        | Revoke                                           |
| GET    | `/routing-policies`              | admin                        | List with active versions                        |
| POST   | `/routing-policies`              | admin                        | Create at version 1, activated                   |
| POST   | `/routing-policies/validate`     | admin                        | Validate without saving                          |
| GET    | `/routing-policies/:id/versions` | admin                        | History                                          |
| POST   | `/routing-policies/:id/versions` | admin                        | Publish **without** activating                   |
| POST   | `/routing-policies/:id/activate` | admin                        | Roll out or roll back                            |
| GET    | `/budgets`                       | admin                        | Budgets with current spend                       |
| POST   | `/budgets`                       | admin                        | Create                                           |
| DELETE | `/budgets/:id`                   | admin                        | Delete                                           |
| GET    | `/usage`                         | usage.read                   | Summary, series, breakdowns, disclosure          |
| GET    | `/usage/providers`               | usage.read                   | Factual provider comparison                      |
| GET    | `/requests`                      | logs.read                    | Request log, filtered and paged                  |
| GET    | `/requests/:id`                  | logs.read                    | Full trace                                       |
| POST   | `/requests/:id/replay`           | logs.read + inference.create | Replay — requires `{"confirm": true}`            |
| GET    | `/webhooks`                      | admin                        | Endpoints (never returns secrets)                |
| POST   | `/webhooks`                      | admin                        | Create — **secret returned once**                |
| DELETE | `/webhooks/:id`                  | admin                        | Delete                                           |
| GET    | `/alerts`                        | admin                        | Rules and recent events                          |
| POST   | `/alerts`                        | admin                        | Create a rule                                    |
| GET    | `/audit-logs`                    | admin                        | Administrative writes                            |
| POST   | `/playground/route-test`         | models.read                  | Dry-run the router; no provider contacted        |
| POST   | `/playground/run`                | inference.create             | Real request, flagged as test traffic            |
| POST   | `/playground/simulate-failure`   | admin                        | Inject a failure into the **mock provider only** |
| POST   | `/playground/reset-circuits`     | admin                        | Close all breakers                               |

## Operational

| Path                    | Auth | Purpose                                                |
| ----------------------- | ---- | ------------------------------------------------------ |
| `GET /`                 | none | Self-description, capabilities, pricing status         |
| `GET /healthz`          | none | Liveness                                               |
| `GET /readyz`           | none | Readiness; `degraded` when no providers are registered |
| `GET /metrics`          | none | Prometheus                                             |
| `GET /health/providers` | none | Measured provider health                               |

## Errors

Every error uses one envelope:

```json
{
  "error": {
    "type": "provider_rate_limit",
    "message": "Provider \"openai\" rate limited this request.",
    "requestId": "req_01J…",
    "retryable": true,
    "provider": "openai",
    "retryAfterSeconds": 20,
    "details": {}
  }
}
```

`type` is from a fixed taxonomy — see [providers.md](./providers.md#error-normalization).
`retryable` tells you whether retrying can possibly help. `requestId` is quotable
in a support request and resolves to a full trace.

Provider error text is never echoed into `message`; it can contain fragments of
your own prompt.

## Pagination

Cursor-based, over the request log:

```bash
curl "$GATEWAY_URL/api/v1/requests?limit=50" …
# → { "data": [...], "nextCursor": "req_01J…" }
curl "$GATEWAY_URL/api/v1/requests?limit=50&cursor=req_01J…" …
```

Request IDs are ULIDs, so the cursor is also chronological order. Filters:
`projectId`, `apiKeyId`, `providerId`, `modelId`, `status`, `from`, `to`,
`search`, `includeTest`.
