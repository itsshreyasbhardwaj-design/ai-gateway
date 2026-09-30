# TypeScript SDK

```bash
pnpm add @ai-gateway/sdk
```

Zero runtime dependencies, with its own copy of the wire types — an application
should not have to install the gateway's internals to call it.

## Getting started

```ts
import { AIGateway } from '@ai-gateway/sdk';

const client = new AIGateway({
  apiKey: process.env.AI_GATEWAY_API_KEY!,
  baseUrl: 'http://localhost:8787',
});

// or from AI_GATEWAY_API_KEY / AI_GATEWAY_URL
const client = AIGateway.fromEnv();
```

| Option           | Default                                     | Notes                                      |
| ---------------- | ------------------------------------------- | ------------------------------------------ |
| `apiKey`         | —                                           | Required                                   |
| `baseUrl`        | `AI_GATEWAY_URL` or `http://localhost:8787` |                                            |
| `timeoutMs`      | `120000`                                    | Per request                                |
| `maxRetries`     | `2`                                         | Connection failures and retryable 5xx only |
| `defaultHeaders` | `{}`                                        |                                            |
| `fetchImpl`      | global `fetch`                              | For tests                                  |

## Completions

```ts
const completion = await client.chat.completions.create({
  model: 'gateway/auto',
  messages: [{ role: 'user', content: 'Hello' }],
});

console.log(completion.choices[0]?.message.content);
console.log(completion.gateway?.provider, completion.gateway?.model);
console.log(completion.gateway?.reasons);

if (completion.usage?.source === 'estimated') {
  // The provider did not report token counts; these were approximated.
}
```

## Streaming

```ts
const stream = await client.chat.completions.stream({
  model: 'gateway/auto',
  messages: [{ role: 'user', content: 'Count to ten.' }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}

// Available once the stream is drained.
console.log(stream.receipt?.attempts, stream.receipt?.estimatedCost);
console.log(stream.text);

// Or drain it in one call:
const { text, receipt } = await stream.finalText();
```

The routing receipt arrives as its own frame and is exposed via `receipt`
rather than yielded as a chunk, so `for await` loops written against the OpenAI
SDK keep working unchanged.

`stream.abort()` cancels, which propagates to the provider so you stop paying
for tokens you will not read.

## Routing control

```ts
await client.chat.completions.create({
  model: 'gateway/cheapest',
  messages,
  gateway: {
    strategy: 'lowest_cost',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-haiku-4'],
    fallback: true,
    cache: 'no-store',
    timeoutMs: 30_000,
    tags: ['checkout-summariser'],
  },
});
```

## Dry-running the router

```ts
const plan = await client.routing.test({
  model: 'gateway/auto',
  prompt: 'Explain this SQL query.',
  strategy: 'lowest_latency',
});

plan.selected?.model; // what would be chosen
plan.selected?.reasons; // why
plan.chain; // the fallback chain behind it
plan.rejected; // every excluded candidate, with its reason
```

No provider is contacted and nothing is billed.

## Introspection

```ts
const models = await client.models.list();
models.gateway.pricingVersion; // which price table produced the costs
models.gateway.pricingAgeDays; // how stale it is

const limits = await client.limits.retrieve(); // pace without probing for 429s
const usage = await client.usage.retrieve({ range: '7d' });
const trace = await client.requests.retrieve('req_01J…');
```

## Errors

```ts
import { AIGatewayError, AIGatewayTimeoutError, AIGatewayConnectionError } from '@ai-gateway/sdk';

try {
  await client.chat.completions.create({/* … */});
} catch (err) {
  if (AIGatewayError.isAIGatewayError(err)) {
    err.type; // normalized, e.g. 'provider_rate_limit'
    err.status; // HTTP status
    err.retryable; // whether retrying can help
    err.requestId; // quotable; resolves to a full trace
    err.retryAfterSeconds; // present on 429
  } else if (err instanceof AIGatewayTimeoutError) {
    // the client's own deadline elapsed
  } else if (err instanceof AIGatewayConnectionError) {
    // the gateway was unreachable
  }
}
```

## Retry behaviour

Client-side retries are deliberately conservative: the gateway already retries
and fails over server-side with proper backoff, so retrying here too would
multiply load on a struggling provider.

The client retries **only** connection failures and 5xx responses the gateway
marked retryable. A 429 is never retried automatically — it carries a
`retryAfterSeconds` the gateway computed, and respecting it is the caller's
decision, not something to paper over.

```ts
await client.chat.completions.create(params, { maxRetries: 0 });
```
