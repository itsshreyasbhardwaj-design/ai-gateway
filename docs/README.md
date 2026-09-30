# Documentation

| Document                               | What it covers                                                   |
| -------------------------------------- | ---------------------------------------------------------------- |
| [architecture.md](./architecture.md)   | How the pieces fit together and why the seams are where they are |
| [gateway.md](./gateway.md)             | The request pipeline, stage by stage                             |
| [providers.md](./providers.md)         | The provider abstraction and writing an adapter                  |
| [routing.md](./routing.md)             | Strategies, scoring, and how a route is chosen                   |
| [fallback.md](./fallback.md)           | Retries, failover, circuit breaking                              |
| [caching.md](./caching.md)             | Exact and semantic caching, and when not to                      |
| [rate-limits.md](./rate-limits.md)     | Distributed limiting and the two-phase token accounting          |
| [budgets.md](./budgets.md)             | Spend controls and what they can and cannot promise              |
| [pricing.md](./pricing.md)             | Why pricing is configuration, and how to keep it honest          |
| [security.md](./security.md)           | Threat model, controls, and known limitations                    |
| [observability.md](./observability.md) | Traces, metrics, logs, and what each is for                      |
| [api.md](./api.md)                     | HTTP reference                                                   |
| [sdk.md](./sdk.md)                     | TypeScript client                                                |
| [cli.md](./cli.md)                     | `aigw`                                                           |
| [mcp.md](./mcp.md)                     | The read-only MCP server                                         |
| [self-hosting.md](./self-hosting.md)   | Running it for real                                              |

## A note on the tone of these documents

They try to be honest about limits. Where something is approximate, unverified,
or only correct under an assumption, that is stated next to the claim rather
than in a caveats section at the end. A gateway is infrastructure people make
spending decisions with; documentation that oversells it is a liability.
