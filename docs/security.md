# Security

## Threat model

The gateway holds provider credentials, sees every prompt, and sits inside a
private network. The assumptions it works from:

- Every request is untrusted, including from inside the network.
- An API key will leak eventually. Blast radius must be bounded by scope,
  project and budget, and revocation must be immediate.
- A database dump will happen. It must not yield usable credentials.
- An administrator can be tricked into pasting a hostile URL.
- Model output is untrusted input. It must never influence gateway policy.

## Authentication

Keys are `aigw_{live,test}_<24 random bytes, base64url>`.

- Stored as a **salted scrypt hash** (N=16384, r=8, p=1). The plaintext is shown
  once at creation and never persisted.
- Looked up by a **peppered HMAC-SHA256 index**, so a database dump cannot be
  used to precompute lookups, and authentication is one indexed read rather than
  a scan that scrypt-verifies every candidate.
- Verification is **constant-time**.
- Every failure — absent, malformed, unknown, revoked, expired — returns the
  same 401 with the same message. Distinguishing them tells an attacker which
  prefixes exist.

### The verification cache, and why it is safe

scrypt at N=16384 costs ~47ms. That is the right price for a stored password
hash and the wrong price to pay on every inference request. Successful
verifications are cached for 30 seconds.

- Keyed by the **peppered HMAC**, never the plaintext.
- **Only successes are cached.** A wrong key costs an attacker full scrypt every
  time, so the cache cannot accelerate guessing.
- **Revocation and rotation invalidate explicitly.** Revocation that took effect
  in 30 seconds would not be revocation. End-to-end tests assert a key revoked
  through the API stops working on the very next request.

The residual exposure is a key whose state changes _outside_ the API — edited
directly in the database — which can remain valid for up to the TTL.

## Authorization

Five scopes: `models.read`, `inference.create`, `usage.read`, `logs.read`,
`admin` (which implies the rest). Enforced server-side on every request; a
caller cannot widen its own scopes by asking.

Tenant isolation is enforced at the query layer — every tenant-scoped read takes
an organization id — and backed by PostgreSQL row-level security policies as
defence in depth, so a missing `WHERE` clause is an empty result rather than a
cross-tenant leak.

Reading that a request _happened_ (`logs.read`) and reading _what was in it_ are
separate: bodies are governed by the retention policy and stored in their own
table.

## Secrets at rest

Provider credentials and webhook signing secrets are sealed with
**AES-256-GCM**, with a random 96-bit nonce per record and the provider id bound
in as additional authenticated data — so a stolen blob cannot be replayed
against a different provider.

Provider configuration rows hold a credential _reference_, never a value. The
admin API returns the reference and never the secret.

`ENCRYPTION_KEY` and `API_KEY_PEPPER` are **required in production**; the
gateway refuses to start without them. In development it generates throwaway
values and warns that stored secrets will not survive a restart.

## SSRF

Custom provider base URLs and webhook targets are outbound requests made from
inside your network by a process holding credentials. Both are **deny-by-default**:

- Only `http`/`https`; plain `http` only for explicitly allowlisted hosts
- Credentials embedded in a URL are rejected
- Private, loopback, link-local, CGNAT, multicast and reserved ranges blocked
- Cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`) always
  blocked
- Decimal, octal, hex and IPv4-mapped-IPv6 encodings normalised before checking
- Only administrators can configure an arbitrary URL at all

Self-hosted models are supported by explicit allowlist:

```bash
PROVIDER_ALLOWED_HOSTS=ollama.internal,127.0.0.1,*.svc.cluster.local
```

**Known limitation, stated plainly:** the guard inspects the hostname as
written. A hostname that DNS later resolves to a private address is not caught.
Deployments needing that guarantee should pair this with an egress proxy or a
DNS-pinning HTTP agent.

## Logging and prompts

Redaction is not optional and not the caller's responsibility. Every field
passes through a deep redactor before reaching a sink, with a **positive
allowlist** for headers — naming the headers that may be logged rather than the
ones that may not.

Never logged: API keys, provider secrets, `Authorization` and `Cookie` headers,
anything matching a known key shape (`sk-`, `sk-ant-`, `aigw_`, `AIza`, `ghp_`,
bearer tokens), and any field whose name matches a sensitive pattern.

Prompt retention is per organization, defaulting to the conservative option:

| Mode            | Stored                                         |
| --------------- | ---------------------------------------------- |
| `none`          | Nothing                                        |
| `metadata_only` | **Default.** Routing, tokens, cost — no bodies |
| `redacted`      | Bodies with secrets stripped                   |
| `full`          | Bodies verbatim                                |

Bodies live in their own table with an expiry, so retention is enforced by
deleting from one place and the analytics path never touches them. The worker
sweeps expired bodies on a timer.

Provider error _text_ is never echoed to the caller — it can contain fragments
of the caller's own prompt. It is kept on the trace for operators.

## Webhooks

Signed `HMAC-SHA256` over `<timestamp>.<body>`:

```
x-aigw-signature: t=1790741520,v1=3f8a…
```

Signing the timestamp alongside the body is what makes a captured payload
unusable later. Verify in constant time and reject a timestamp outside a few
minutes:

```ts
import { verifyWebhook } from '@ai-gateway/security';
const result = verifyWebhook(rawBody, request.headers['x-aigw-signature'], secret);
if (!result.valid) return reply.status(400).send({ reason: result.reason });
```

Failed deliveries retry with exponential backoff; an endpoint that fails
persistently is disabled rather than retried forever.

## Prompt injection

Model output never influences gateway policy. Routing, budgets, allowlists and
rate limits are computed from configuration and measured signals only, before
the model is called. There is no path by which a completion can change what the
gateway does next.

The optional analytics assistant retrieves real data before answering and does
not modify routing; any policy change requires explicit human confirmation.

## Abuse and resource limits

- Per-key, per-user, per-project, per-organization, per-model and per-provider
  rate limits
- Budgets at three scopes with a projected-cost pre-check
- Request body size limits, with a policy-level override
- Output token clamping
- Per-request deadlines, clamped by policy
- Client disconnection aborts the upstream call

## What is tested

54 end-to-end security tests, asserting attacks _fail_:

cross-tenant trace/usage/cache access · scope bypass and self-escalation · SSRF
across ten encodings, for providers and webhooks · budget bypass via every
request flag · rate-limit bypass via the test flag · API key leakage into logs ·
provider secret leakage through the API · prompt leakage under each retention
mode · webhook signature tampering and replay · allowlist bypass via
`gateway.models` and virtual models · replay without confirmation · failure
simulation against a real provider.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
