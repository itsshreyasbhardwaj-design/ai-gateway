# Architecture

## The shape of the thing

```
  application
      │
      │  POST /v1/chat/completions      (OpenAI-compatible)
      ▼
┌─────────────────────────────────────────────────────────────┐
│                        Gateway (Fastify)                    │
│                                                             │
│   authenticate ─▶ rate limit ─▶ policy ─▶ budget ─▶ cache   │
│                                                     │        │
│                                                     ▼        │
│                                                  router      │
│                                                     │        │
│                                                     ▼        │
│                                            retry + fallback  │
│                                                     │        │
└─────────────────────────────────────────────────────┼───────┘
                                                      ▼
                                            ┌──────────────────┐
                                            │ provider adapter │
                                            └──────────────────┘
                                                      │
                                                      ▼
                                                    model
```

Every stage writes to the request trace. Nothing that costs money happens
before every gate that could refuse it — that ordering is the whole design.

## Repository layout

```
apps/
  gateway/      the HTTP service: pipeline, routes, auth
  worker/       health probes, retention, alerts, webhook delivery
  dashboard/    Next.js operator console
  cli/          aigw
  mcp/          read-only MCP server

packages/
  core/         normalized types, error taxonomy, ULIDs, redaction, SSE codec
  provider-sdk/ HTTP client, registry, credential resolution, stream helpers
  providers/    adapters: OpenAI-compatible, Anthropic, Google, mock
  router/       strategies, planning, retry policy, fallback executor
  policies/     policy schema, versioning, pre-execution policy engine
  cache/        KV abstraction, exact cache, semantic cache
  rate-limit/   distributed sliding-window limiter
  usage/        budgets, spend counters, analytics aggregation
  pricing/      versioned price book and cost calculation
  observability/logging, metrics, health tracking, circuit breakers, traces
  security/     SSRF guard, key hashing, encryption, webhook signing
  database/     Store contract, in-memory and Postgres implementations
  config/       environment parsing and provider derivation
  sdk/          published TypeScript client (zero dependencies)
  ui/           shared design tokens and formatting
```

## The seams that matter

### One provider interface, no vendor branches in the core

```ts
interface AIProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse>;
  stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk>;
  embed?(request: EmbeddingsRequest, ctx: ProviderCallContext): Promise<EmbeddingsResponse>;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
}
```

Adapters own all wire translation. No route handler branches on provider id, no
vendor shape reaches the router, and adding a provider is a registration rather
than a change to the request path. That constraint is what makes the mock
provider able to exercise the entire gateway.

### Storage behind a contract, with two implementations

`Store` has an in-memory implementation and a PostgreSQL one. The in-memory one
is not a stub — it enforces the same tenant scoping, so a cross-tenant bug fails
in the test suite rather than only in production. It is what makes `pnpm dev`
work with nothing installed but Node.

The same applies to `KeyValueStore`: in-process for one replica, Redis when
counters have to agree across several.

### Pricing and the model catalog are configuration, not knowledge

Neither is hardcoded anywhere in the request path. The shipped price table is
explicitly labelled unverified, and the gateway says so — in the boot banner, in
`GET /`, in `/v1/models`, on every cost figure in the dashboard, and in the CLI.
See [pricing.md](./pricing.md).

### Injected clock

Retry backoff, circuit breakers, budget periods and rate-limit windows all take
a `Clock`. Tests advance it deterministically instead of sleeping, which is why
the suite runs in about a second and why the backoff tests are not flaky.

## Request lifecycle

1. **Authenticate.** Peppered HMAC lookup, one scrypt verification, result
   cached briefly. See [security.md](./security.md).
2. **Rate limit.** Sliding-window, request-unit rules consumed now, token-unit
   rules reserved on an estimate. See [rate-limits.md](./rate-limits.md).
3. **Evaluate policy.** Scopes, allow/deny lists, streaming and tool
   permissions, output clamping. Every adjustment is recorded, never silent.
4. **Check budget.** On the _projected_ cost, before dispatch.
5. **Look up cache.** Off by default; `no-store` always honoured.
6. **Plan the route.** Capability filter, health and circuit filter, budget
   filter, then strategy scoring. Returns the whole ranked chain plus every
   exclusion and its reason.
7. **Execute.** Retry a target while the error says retrying can help; fail over
   while the error says a different provider can help; stop when neither is true.
8. **Record.** Usage, cost, trace, metrics. Spend counters updated.

## What runs where

| Process   | Responsibility                             | Scales by                                                                |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| gateway   | Inference requests, admin API              | Replicas behind a load balancer; needs Redis to share counters           |
| worker    | Health probes, retention, alerts, webhooks | One is usually enough; `FOR UPDATE SKIP LOCKED` makes more than one safe |
| dashboard | Operator console                           | Stateless; a client of the gateway's admin API                           |

The dashboard deliberately does not read the database. It calls the same admin
API you would, so it cannot do anything an API key could not, and the gateway's
authorization and audit logging apply to everything it does.
