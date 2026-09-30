# MCP server

Exposes the gateway's observability to an MCP-capable agent.

```bash
pnpm --filter @ai-gateway/mcp build
```

```jsonc
{
  "mcpServers": {
    "ai-gateway": {
      "command": "node",
      "args": ["/path/to/ai-gateway/apps/mcp/dist/bin.js"],
      "env": {
        "AI_GATEWAY_URL": "http://localhost:8787",
        "AI_GATEWAY_API_KEY": "aigw_live_…",
      },
    },
  },
}
```

## Read-only by design

The tools answer questions and nothing more. An agent with this server attached
**cannot** create API keys, change routing, publish pricing, delete anything, or
spend money.

That is a deliberate boundary, not an oversight. Exposing unrestricted
administrative execution to an agent would mean a prompt injection in a model
response could reroute production traffic or mint a credential.

| Tool                  | Returns                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `list_models`         | Models with capabilities, context windows, configured pricing         |
| `get_model`           | One model's full record                                               |
| `list_providers`      | Providers with measured health                                        |
| `get_provider_health` | Success rate, error rate, latency percentiles, circuit state          |
| `get_usage`           | Usage, cost and latency over a range, with breakdowns                 |
| `list_requests`       | Recent requests, filterable                                           |
| `get_request`         | Full trace: every step, every attempt, and why it routed where it did |
| `get_routing_policy`  | Policies and their active versions                                    |
| `simulate_route`      | Dry-runs the router — computes, but contacts no provider              |

`simulate_route` is the only tool that computes rather than reads, and it is
still side-effect free.

## Scopes

Give the MCP server its own key with only what it needs:

```bash
curl -X POST $GATEWAY_URL/api/v1/api-keys \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"name": "mcp (read-only)", "projectId": "proj_…",
       "scopes": ["models.read", "usage.read", "logs.read"]}'
```

Note what is absent: `inference.create` and `admin`. The gateway enforces that
server-side, so even a compromised MCP server cannot exceed it.

## What an agent can actually do with this

```
"Why did costs go up this week?"
  → get_usage(range: '7d') then get_usage(range: '30d'), compare, and read the
    per-model breakdown. The disclosure block tells it which price table
    produced the numbers and what share of tokens were estimated.

"Which provider had the most failures yesterday?"
  → list_requests(status: 'error', ...) grouped by provider, then
    get_provider_health for context.

"What changed before latency increased?"
  → get_usage for the series, then get_request on slow requests to see whether
    the time went to the provider or to gateway-side retries.

"Would routing change if I used lowest_cost?"
  → simulate_route(strategy: 'lowest_cost'), which contacts no provider.
```

An agent answering those must retrieve the data first. Nothing here invites it
to speculate, and the disclosure blocks make the limits of each number explicit.

## Prompt injection

Data returned by these tools is data. The gateway's own behaviour cannot be
changed through them: routing, budgets and limits come from configuration and
measured signals, computed before any model is called.
