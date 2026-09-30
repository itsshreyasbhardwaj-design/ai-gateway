# Security policy

## Reporting a vulnerability

Please **do not** open a public issue.

Use [GitHub's private vulnerability reporting](https://github.com/itsshreyasbhardwaj-design/ai-gateway/security/advisories/new)
for anything security-relevant.

Useful to include: what you can do with it, the smallest reproduction you have,
and which version or commit you tested. A proof of concept against a local
`pnpm dev` gateway is ideal.

You can expect an acknowledgement within a few days and an assessment within a
week. This is a volunteer-maintained project, so please be patient; if something
is being actively exploited, say so prominently and it will be prioritised.

## Scope

In scope: the gateway service, admin API, provider adapters, SDK, CLI, MCP
server, dashboard, and the Docker images built from this repository.

Out of scope: vulnerabilities in the model providers themselves, and issues that
require an attacker to already hold an `admin`-scoped API key (that scope is
full administrative control by design — see
[docs/security.md](./docs/security.md)).

## Things worth attacking

The security model and its controls are documented in
[docs/security.md](./docs/security.md). Fifty-four end-to-end tests assert that
attacks fail, covering cross-tenant access, scope escalation, SSRF, budget and
rate-limit bypass, secret and prompt leakage, and webhook replay.

Known limitations are stated there rather than hidden. Two in particular:

- **The SSRF guard inspects the hostname as written.** A hostname that DNS later
  resolves to a private address is not caught. This is documented, and
  deployments needing that guarantee should pair it with an egress proxy or a
  DNS-pinning agent. A bypass _of the stated guard_ is in scope; DNS rebinding
  is a known gap rather than a finding.
- **Verified API keys are cached for 30 seconds.** Revocation and rotation
  through the API invalidate immediately. A key whose state is changed directly
  in the database can remain valid for up to the TTL. A way to make a key
  revoked _through the API_ keep working is a vulnerability.

## What the project commits to

- Secrets are never logged, never returned by an API, and never stored in
  plaintext.
- Tenant isolation is enforced in the query layer and backed by row-level
  security.
- A configured budget or rate limit cannot be bypassed by any request-level
  flag.
- Failure modes fail closed where spend is concerned, and fail open only where
  the alternative is breaking inference for a counter outage.

If you find a way to violate one of those, it is a bug regardless of severity.
