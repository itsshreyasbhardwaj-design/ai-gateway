# AI Gateway

One OpenAI-compatible API in front of every model provider, with routing,
fallback, budgets, caching, and a complete answer to _why did my request go
there and what did it cost_.

```bash
git clone https://github.com/itsshreyasbhardwaj-design/ai-gateway
cd ai-gateway && pnpm install && pnpm dev
```

That is a working gateway. No database, no Redis, no accounts, no cloud — it
boots with an in-memory store and a synthetic provider, prints an API key once,
and tells you exactly which of its parts are and are not production-ready.

---

## The problem

An application that talks to one model provider directly inherits that
provider's outage as its own outage, its rate limits as its own ceiling, and its
pricing as a number nobody is tracking. Adding a second provider means writing
the translation twice, and now nobody knows what anything costs or why a
particular request went where it went.

## What this does about it

```
application
    │  POST /v1/chat/completions
    ▼
authenticate → rate limit → policy → budget → cache → route → retry/fallback
    ▼
provider adapter → model
```

Nothing that costs money happens before every gate that could refuse it. Every
stage records what it decided and why, so the answer to "why did this request
cost that?" comes from recorded fact rather than reconstruction.

---

## Five minutes

```bash
pnpm install
pnpm dev
```

```
  AI Gateway is ready.

  API key : aigw_test_…

  curl http://localhost:8787/v1/chat/completions \
    -H "Authorization: Bearer aigw_test_…" \
    -H "Content-Type: application/json" \
    -d '{"model":"gateway/auto","messages":[{"role":"user","content":"hello"}]}'
```

The response carries the routing decision:

```jsonc
{
  "choices": [{ "message": { "role": "assistant", "content": "…" } }],
  "usage": { "input": 24, "output": 118, "total": 142, "source": "provider_reported" },
  "gateway": {
    "requestId": "req_01J…",
    "provider": "anthropic",
    "model": "anthropic/claude-haiku-4",
    "strategy": "highest_reliability",
    "reasons": [
      "strategy: highest_reliability",
      "measured success rate 99.8% over 2104 requests",
      "3 of 5 candidates eligible",
    ],
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
    "estimatedCost": { "amount": 0.00031, "currency": "USD", "pricingVersion": "2026-09" },
  },
}
```

Point a real provider at it by setting one variable:

```bash
OPENAI_API_KEY=sk-… pnpm dev
```

Or run the durable stack:

```bash
docker compose up -d
```

---

## Migrating an existing app

Usually a base-URL change:

```diff
 const client = new OpenAI({
-  apiKey: process.env.OPENAI_API_KEY,
+  apiKey: process.env.AI_GATEWAY_API_KEY,
+  baseURL: 'http://localhost:8787/v1',
 });
```

Streaming, tool calls and `response_format` keep working. Everything the gateway
adds is namespaced under `gateway` or `x-gateway-*`, so no existing client
parser breaks. See [examples/openai-sdk-migration.md](./examples/openai-sdk-migration.md).

---

## What is in the box

**Routing.** Eight strategies over measured cost, latency and success rate.
Deliberately no "best model" ranking — the gateway has no defensible way to
measure output quality. Every plan returns the full ranked chain plus every
excluded candidate and why.

**Reliability.** Retries only errors that retrying can fix; fails over only
errors a different provider can fix; a malformed request stops the chain instead
of being replayed against every vendor. Circuit breakers need sustained failure,
not one bad request.

**Cost.** Versioned price tables, so publishing new prices never rewrites
history. Budgets at three scopes evaluated on projected cost _before_ dispatch.
Every cost figure states which table produced it and how stale that table is.

**Caching.** Exact and semantic, off by default, with `no-store` always honoured
and tenant isolation built into the key rather than checked afterwards.

**Observability.** A trace per request with every pipeline stage and provider
attempt. Prometheus metrics. Analytics that exclude test traffic and disclose
what share of their token counts were estimated.

**Security.** scrypt-hashed keys with peppered lookup, AES-256-GCM secrets at
rest, deny-by-default SSRF guards, mandatory log redaction, four prompt-retention
modes defaulting to the conservative one.

**Tooling.** TypeScript SDK, `aigw` CLI, read-only MCP server, operator
dashboard.

---

## The dashboard

`pnpm dev:dashboard`, then `http://localhost:3000`.

An infrastructure console: dense tables, one accent, tabular figures. Every
number carries its own caveat — the cost tile names the price table behind it,
estimated token counts are labelled wherever they appear, and the top bar states
plainly when the store is not durable or the pricing is unverified.

The request trace is the centrepiece: all eleven pipeline stages, every provider
attempt with the backoff that preceded it, and the routing reasons recorded at
decision time.

---

## Testing and measurement

```bash
pnpm test        # 375 unit tests
pnpm test:e2e    # 84 end-to-end tests against a real gateway
pnpm test:integration  # 26 against real Postgres and Redis
pnpm bench
```

The end-to-end suite runs the real pipeline, router, policy engine and HTTP
surface; only the provider and storage backends are substituted. Fifty-four of
those tests are security tests asserting attacks _fail_: cross-tenant access,
scope escalation, SSRF across ten encodings, budget and rate-limit bypass,
secret and prompt leakage, webhook replay.

Benchmarks on an 8-core Apple M2, in-process, against a zero-latency synthetic
provider:

| Benchmark            | req/s | p50     | p95     | p99     |
| -------------------- | ----- | ------- | ------- | ------- |
| chat (serial)        | 2401  | 0.37ms  | 0.57ms  | 1.24ms  |
| chat (c=32)          | 1980  | 15.09ms | 23.09ms | 33.24ms |
| chat (streaming)     | 1537  | 4.99ms  | 6.57ms  | 6.80ms  |
| chat (cache hit)     | 6278  | 0.14ms  | 0.18ms  | 0.26ms  |
| route plan (dry-run) | 5134  | 0.18ms  | 0.24ms  | 0.29ms  |

Against a provider delayed by a realistic 200ms, the gateway is ~0.2% of total
latency at p50.

These are single-process, loopback, in-memory-store numbers on one machine. They
are a regression signal, not a capacity plan — Postgres and Redis add real
latency none of them reflect.

---

## Two things this is honest about

**Pricing is configuration, not knowledge.** The shipped price table is
placeholder data, clearly labelled as unverified in the boot banner, the API,
the dashboard and the CLI. Replace it before treating any cost as real.
[docs/pricing.md](./docs/pricing.md)

**The mock provider is visibly synthetic.** It exists so the whole gateway is
exercisable with no credentials and no network. Every completion it returns says
so, and it is never registered under a real vendor's id.

---

## Documentation

|                                                                                                       |                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [architecture.md](./docs/architecture.md)                                                             | How the pieces fit and why the seams are there |
| [gateway.md](./docs/gateway.md)                                                                       | The pipeline, stage by stage                   |
| [providers.md](./docs/providers.md)                                                                   | The abstraction, and writing an adapter        |
| [routing.md](./docs/routing.md)                                                                       | Strategies and scoring                         |
| [fallback.md](./docs/fallback.md)                                                                     | Retries, failover, circuit breaking            |
| [caching.md](./docs/caching.md)                                                                       | Exact and semantic, and when not to            |
| [rate-limits.md](./docs/rate-limits.md)                                                               | Distributed limiting                           |
| [budgets.md](./docs/budgets.md)                                                                       | Spend controls                                 |
| [pricing.md](./docs/pricing.md)                                                                       | Keeping cost figures honest                    |
| [security.md](./docs/security.md)                                                                     | Threat model, controls, known limits           |
| [observability.md](./docs/observability.md)                                                           | Traces, metrics, logs                          |
| [api.md](./docs/api.md) · [sdk.md](./docs/sdk.md) · [cli.md](./docs/cli.md) · [mcp.md](./docs/mcp.md) | Interfaces                                     |
| [self-hosting.md](./docs/self-hosting.md)                                                             | Running it for real                            |

Runnable [examples](./examples), including inducing a provider failure and
watching fallback recover it.

---

## Development

```bash
pnpm install
pnpm dev              # gateway on :8787
pnpm dev:dashboard    # dashboard on :3000

pnpm test             # unit
pnpm test:e2e         # end-to-end
pnpm typecheck
pnpm lint
pnpm build
```

Unit tests resolve workspace packages straight from TypeScript source, so they
need no build step and the suite runs in about a second. Retry backoff, circuit
breakers and budget periods all take an injected clock, so time-dependent tests
advance it rather than sleeping.

---

## Status

v0.1. The gateway, router, reliability layer, budgets, caching, observability,
SDK, CLI, MCP server and dashboard are implemented and tested. Known limitations
are documented rather than hidden — see the security and pricing documents in
particular.

[Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md) ·
[Changelog](./CHANGELOG.md) · MIT licensed
