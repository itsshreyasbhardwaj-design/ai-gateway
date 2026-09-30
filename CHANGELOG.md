# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-09-30

First release.

### Gateway

- OpenAI-compatible `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`,
  `/v1/models`, `/v1/limits`
- Server-sent-event streaming that forwards chunk by chunk and never buffers the
  response as a unit, with a terminal routing receipt and in-band error frames
  for failures after headers are sent
- Client disconnection aborts the upstream call
- Request pipeline ordered so nothing costing money runs before a gate that
  could refuse it: authenticate → rate limit → policy → budget → cache → route
  → execute

### Providers

- One `AIProvider` interface; no vendor branching anywhere above it
- Adapters for OpenAI-compatible endpoints, Anthropic Messages, Google Gemini,
  and a deliberately synthetic mock provider
- Normalized error taxonomy carrying `retryable` and `failoverable` traits
- Runtime provider registration with SSRF-checked base URLs

### Routing and reliability

- Eight strategies over measured cost, latency and success rate — none ranking
  model quality
- Plans return the full ranked chain plus every excluded candidate and why
- Retries only errors retrying can fix; fails over only errors a different
  provider can fix; a non-failoverable error aborts the chain
- Exponential backoff with full jitter, honouring provider `Retry-After`
- Circuit breakers requiring sustained failure, with probe-based recovery
- Health-aware routing that treats an unmeasured target as unproven, not
  unhealthy

### Cost and control

- Versioned pricing; publishing new prices never rewrites history
- The shipped price table is explicitly labelled unverified in the banner, API,
  dashboard and CLI
- Budgets at organization, project and key scope, evaluated on projected cost
  before dispatch, with BLOCK / WARN / downgrade actions
- Distributed sliding-window rate limiting with two-phase token accounting
- Rate limits configurable per routing policy

### Caching

- Exact and semantic caching, off by default
- `gateway.cache: no-store` always honoured
- Tenant isolation built into the cache key
- Cache hits record zero cost and keep the original producer's attribution

### Observability

- A trace per request: every pipeline stage, every provider attempt, the backoff
  that preceded it, and the routing reasons recorded at decision time
- Gateway overhead reported separately from provider time
- Prometheus metrics, including a reported-versus-estimated token breakdown
- Analytics that exclude test traffic and disclose what share of token counts
  were estimated
- Factual provider comparison with no composite score

### Security

- scrypt-hashed API keys with a peppered HMAC lookup index
- Verified keys cached for 30s, keyed by the HMAC, successes only, with
  immediate invalidation on revoke and rotate
- AES-256-GCM secrets at rest, bound to the provider id
- Deny-by-default SSRF guards for provider and webhook URLs
- Mandatory log redaction with a positive header allowlist
- Four prompt-retention modes, defaulting to metadata-only
- Signed webhooks with timestamp binding and replay rejection
- Row-level security on tenant-scoped tables as defence in depth

### Tooling

- `@ai-gateway/sdk`: zero-dependency TypeScript client
- `aigw` CLI with local policy validation
- Read-only MCP server
- Next.js operator dashboard

### Operations

- Migrations serialise across processes with a PostgreSQL advisory lock, so a
  deployment that rolls the gateway and worker together does not deadlock
- Docker images run unprivileged with `tini` as PID 1, so `SIGTERM` is forwarded
  and graceful shutdown drains in-flight streaming responses

### Testing and performance

- 375 unit tests, 84 end-to-end tests, 54 of them adversarial security tests
- Benchmark harness reporting percentiles and separating gateway overhead from
  provider time
- Gateway p50 of 0.37ms against a zero-latency provider; ~0.2% of total latency
  against a 200ms provider

[Unreleased]: https://github.com/itsshreyasbhardwaj-design/ai-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/itsshreyasbhardwaj-design/ai-gateway/releases/tag/v0.1.0
