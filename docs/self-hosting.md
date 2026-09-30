# Self-hosting

## The shortest version

```bash
pnpm install
pnpm dev
```

That is a working gateway. No database, no Redis, no accounts, no cloud. It
boots with an in-memory store and the synthetic mock provider, prints a
bootstrap API key once, and tells you exactly what it is and is not:

```
environment: development
store: in-memory (not durable)
counters: in-process (single replica only)
providers: mock
note: only the synthetic mock provider is configured. Set a provider API key to route real traffic.
warning: DATABASE_URL: Using the in-memory store. Data is lost on restart.
warning: pricing table "seed-unverified-v1" is the shipped placeholder set and is NOT verified …
```

Add a real provider by setting one key:

```bash
OPENAI_API_KEY=sk-… pnpm dev
```

## What you actually need for production

| Component        | Required         | Consequence of omitting                                                                                                               |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Node 20.10+      | yes              | —                                                                                                                                     |
| PostgreSQL 14+   | **yes**          | The in-memory store loses every request, key and policy on restart. The gateway refuses to start in production without `DATABASE_URL` |
| Redis 6+         | for >1 replica   | Rate limits and spend counters are per-process. Three replicas with a 600/min limit collectively allow 1800/min                       |
| `ENCRYPTION_KEY` | **yes**          | Refuses to start. Provider credentials would be unprotected                                                                           |
| `API_KEY_PEPPER` | **yes**          | Refuses to start. A database dump could be used to precompute key lookups                                                             |
| A provider key   | to serve traffic | `/readyz` reports `degraded` with no providers registered                                                                             |

## Docker Compose

```bash
cp .env.example .env
# set ENCRYPTION_KEY and API_KEY_PEPPER: openssl rand -base64 32
docker compose up -d
```

Brings up Postgres, Redis, the gateway, the worker and the dashboard. Gateway on
`:8787`, dashboard on `:3000`.

For just the backing services while developing locally:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgresql://aigw:aigw@localhost:5432/aigw pnpm db:migrate
DATABASE_URL=… REDIS_URL=redis://localhost:6379 pnpm dev
```

## Building images

One Dockerfile, three targets:

```bash
docker build --target gateway   -t ai-gateway/gateway .
docker build --target worker    -t ai-gateway/worker .
docker build --target dashboard -t ai-gateway/dashboard .
```

All run unprivileged as `node`, with `tini` as PID 1 so `SIGTERM` is forwarded
and graceful shutdown actually drains in-flight streaming responses instead of
killing them mid-stream.

## Migrations

```bash
DATABASE_URL=postgresql://… pnpm db:migrate
```

Idempotent and transactional — safe to run on every deploy. The schema is in
`packages/database/migrations/0001_init.sql`.

Migration takes a PostgreSQL advisory lock, so several processes starting at
once serialise rather than deadlock. The gateway and the worker both migrate on
boot and a deployment rolls them together, which is exactly the case that
deadlocks without it.

It enables row-level security on the tenant-scoped tables as defence in depth.
The application always scopes by organization id; RLS means a missing `WHERE`
clause is an empty result rather than a cross-tenant leak.

## Scaling

**Gateway** is stateless. Run several behind a load balancer. With `REDIS_URL`
set, they agree on rate limits and spend; without it they do not, and `GET /`
reports `countersDurable: false`.

**Worker** — one is usually enough. More than one is safe: webhook delivery uses
`FOR UPDATE SKIP LOCKED`, so two workers do not deliver the same webhook twice.

**Dashboard** is stateless and a client of the gateway's admin API.

## Health checks

```
/healthz   liveness — is the process up?
/readyz    readiness — can this replica serve?
```

`/readyz` returns 503 when no providers are registered. A gateway that is up but
has nothing to route to will 503 every request, and rolling it into a load
balancer would be worse than leaving it out.

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 8787 }
  initialDelaySeconds: 10
readinessProbe:
  httpGet: { path: /readyz, port: 8787 }
  initialDelaySeconds: 5
```

Give pods a `terminationGracePeriodSeconds` of at least 30: the gateway drains
in-flight streaming responses on `SIGTERM`, and a streamed completion can take a
while.

## Backups

The request log grows fastest. The retention job prunes request metadata at 10×
the body retention window with a 90-day floor, and prompt bodies at exactly the
configured window.

What is irreplaceable: organizations, projects, API key hashes, routing policy
versions, pricing versions, budgets. Those are small. Back them up properly;
request history is comparatively disposable.

Losing Redis loses in-flight rate-limit windows and spend counters. Counters can
be reconciled from the requests table. `appendonly yes` in the compose file
avoids the issue for the common case, since losing a spend counter mid-month
silently resets a budget.

## Upgrading

1. Read `CHANGELOG.md`.
2. Run `pnpm db:migrate` — migrations are idempotent.
3. Roll the gateway. It is backwards compatible within a minor version.
4. Roll the worker and dashboard.

## After deploying

```bash
AI_GATEWAY_API_KEY=… ./scripts/smoke.sh https://gateway.example.com
```

Exercises the full flow — models, completion, streaming with a terminal receipt,
trace retrieval, usage, metrics — and fails loudly, so it is usable as a gate.

## Common problems

**`/readyz` returns 503 with "no providers registered".** No provider
credentials were found, or a provider failed to construct. Check the boot
banner; it names each provider that did not register and why.

**"pricing table is NOT verified".** Expected on a fresh install. Publish a
verified table — see [pricing.md](./pricing.md).

**Rate limits behave inconsistently across replicas.** `REDIS_URL` is not set.
Counters are per-process.

**A custom provider URL is rejected.** The SSRF guard is deny-by-default for
private addresses. Allowlist it deliberately:
`PROVIDER_ALLOWED_HOSTS=ollama.internal`. See [security.md](./security.md).

**Secrets stop working after a restart in development.** `ENCRYPTION_KEY` was
not set, so a throwaway key was generated per process. The boot banner warns
about this.
