# CLI

```bash
pnpm --filter @ai-gateway/cli build
npm link   # or run directly: node --import tsx apps/cli/src/bin.ts
```

## Authenticating

```bash
aigw login                          # prompts for URL and key
aigw login --url https://gw.example.com --key aigw_live_…
aigw whoami
aigw logout
```

Credentials are written to `~/.config/aigw/config.json` with mode 0600.
`AI_GATEWAY_API_KEY` and `AI_GATEWAY_URL` always take precedence, so CI never
needs to write a file.

`--profile NAME` keeps several gateways side by side.

## Commands

```bash
aigw models list [--provider ID] [--capability tools]
aigw providers list
aigw usage [--range 1h|24h|7d|30d|90d] [--include-test]
aigw requests list [--limit N] [--status error] [--provider openai] [--search TEXT]
aigw request get REQUEST_ID
aigw routing list
aigw routing validate POLICY_FILE
aigw routing test "PROMPT" [--model M] [--strategy S]
aigw chat "PROMPT" [--model M] [--no-stream]
```

Every command takes `--json` for machine-readable output, `--url` to override
the gateway, and `--help`.

## Worth knowing

**`routing validate` runs the same parser the gateway does**, so CI gets the
same verdict a deploy would. It exits non-zero on error and prints warnings
without failing:

```bash
$ aigw routing validate examples/routing-policy.yaml

✓ examples/routing-policy.yaml is valid. checksum tkTuKDnh0GB5PMl4CQ2-nc

  strategy   highest_reliability
  models     openai/gpt-4o-mini → anthropic/claude-haiku-4-20250514
  fallback   up to 3 targets
  retry      3 attempts, exponential backoff, full jitter
  cache      off

  warn   fallback.maxTargets: maxTargets is 3 but only 2 model(s) are configured
```

**`routing test` contacts no provider.** It asks the gateway what it _would_ do.

**`request get` prints the full trace** — timeline, attempts, backoff, the
routing reasons, and whether token counts were estimated or reported.

**`chat` streams by default** and prints the routing receipt afterwards, which
makes it a quick way to confirm a gateway is healthy.

## In CI

```yaml
- name: Validate routing policies
  run: |
    for policy in policies/*.yaml; do
      npx aigw routing validate "$policy"
    done
```

```bash
# Fail a deploy if the error rate over the last hour is above 5%
rate=$(aigw usage --range 1h --json | jq '1 - .summary.successRate')
awk -v r="$rate" 'BEGIN { exit (r > 0.05) ? 1 : 0 }'
```
