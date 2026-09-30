# Migrating an existing OpenAI client

The gateway speaks the OpenAI chat-completions wire format, so for most
applications this is a base-URL change and nothing else.

## TypeScript

```diff
 import OpenAI from 'openai';

 const client = new OpenAI({
-  apiKey: process.env.OPENAI_API_KEY,
+  apiKey: process.env.AI_GATEWAY_API_KEY,
+  baseURL: 'http://localhost:8787/v1',
 });

 const completion = await client.chat.completions.create({
-  model: 'gpt-4o-mini',
+  // A concrete model still works; `gateway/auto` lets the router choose.
+  model: 'gateway/auto',
   messages: [{ role: 'user', content: 'Hello' }],
 });
```

Streaming, tool calls, `response_format` and the rest keep working unchanged.

## Python

```diff
 from openai import OpenAI

 client = OpenAI(
-    api_key=os.environ["OPENAI_API_KEY"],
+    api_key=os.environ["AI_GATEWAY_API_KEY"],
+    base_url="http://localhost:8787/v1",
 )
```

## What you get that you did not have

Nothing below breaks an existing client — the additions are namespaced.

**On the response**, a `gateway` object explaining the routing decision:

```jsonc
{
  "choices": [/* … unchanged … */],
  "usage": { "input": 24, "output": 118, "total": 142, "source": "provider_reported" },
  "gateway": {
    "requestId": "req_01J…",
    "provider": "anthropic",
    "model": "anthropic/claude-haiku-4",
    "strategy": "highest_reliability",
    "reasons": ["strategy: highest_reliability", "measured success rate 99.8% over 2104 requests"],
    "cache": "miss",
    "attempts": 2,
    "fallbackUsed": true,
    "latencyMs": 812,
    "estimatedCost": { "amount": 0.00031, "currency": "USD", "pricingVersion": "2026-09" },
  },
}
```

`usage.source` is worth reading: `provider_reported` means the provider gave
those counts, `estimated` means the gateway approximated them because the
provider did not. The gateway never presents one as the other.

**On the request**, an optional `gateway` object to control routing:

```jsonc
{
  "model": "gateway/auto",
  "messages": [/* … */],
  "gateway": {
    "strategy": "lowest_cost",
    "models": ["openai/gpt-4o-mini", "anthropic/claude-haiku-4"],
    "fallback": true,
    "cache": "no-store",
    "timeoutMs": 30000,
    "tags": ["checkout-summariser"],
  },
}
```

**In headers**, the same facts for clients that would rather not parse the body:
`x-request-id`, `x-gateway-provider`, `x-gateway-model`, `x-gateway-strategy`,
`x-gateway-attempts`, `x-gateway-cache`, `x-gateway-usage-source`,
`x-gateway-estimated-cost`, plus the standard `x-ratelimit-*` family.

## Differences worth knowing

- **Model names are namespaced.** `openai/gpt-4o-mini`, not `gpt-4o-mini`. This
  is what makes "the same model through two providers" expressible.
- **Errors are normalized.** A 429 from any provider becomes
  `provider_rate_limit`; the body always carries `type`, `retryable` and
  `requestId`. See [docs/api.md](../docs/api.md).
- **`/v1/responses` is not OpenAI's stateful Responses API.** It accepts the
  same body as chat completions so both paths work, but a request using
  `previous_response_id`, `store` or `conversation` is rejected rather than
  having those fields silently ignored.
- **A model that cannot serve your request is an error, not a substitution.**
  Asking an embeddings model for a completion returns
  `capability_unsupported`; the fallback chain is for provider failures, not
  for a model choice that never matched.
