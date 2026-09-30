# Examples

Runnable against a local gateway. Start one first:

```bash
pnpm dev          # prints a bootstrap API key once, on stdout
export AI_GATEWAY_API_KEY=aigw_...
export AI_GATEWAY_URL=http://localhost:8787
```

| Example                                                | What it shows                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| [`curl.sh`](./curl.sh)                                 | The raw HTTP surface, including streaming and the routing receipt |
| [`openai-sdk-migration.md`](./openai-sdk-migration.md) | Pointing an existing OpenAI client at the gateway                 |
| [`typescript-sdk.ts`](./typescript-sdk.ts)             | The first-party SDK: streaming, routing control, cost             |
| [`fallback.ts`](./fallback.ts)                         | Inducing a provider failure and watching fallback recover it      |
| [`budgets.ts`](./budgets.ts)                           | Setting a budget and observing it refuse a request                |
| [`routing-policy.yaml`](./routing-policy.yaml)         | A commented policy covering every option                          |
