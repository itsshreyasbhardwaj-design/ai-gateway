# Providers

## The interface

```ts
interface AIProvider {
  readonly id: string;
  readonly kind: string;

  listModels(): Promise<ModelDescriptor[]>;
  chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse>;
  stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk>;
  embed?(request: EmbeddingsRequest, ctx: ProviderCallContext): Promise<EmbeddingsResponse>;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
}
```

Adapters own all wire translation. Nothing above this interface knows which
vendor is being called.

## Shipped adapters

| Adapter                    | Covers                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `OpenAICompatibleProvider` | OpenAI, OpenRouter, Together, Groq, Fireworks, vLLM, Ollama, LM Studio, most "bring your own base URL" deployments |
| `AnthropicProvider`        | Anthropic Messages API                                                                                             |
| `GoogleProvider`           | Google Generative Language API                                                                                     |
| `MockProvider`             | Development and testing. Synthetic, clearly labelled, never aliased onto a vendor id                               |

The OpenAI-compatible adapter is the workhorse because the wire format is the de
facto standard. A new vendor that speaks it needs configuration, not code.

## What translation actually involves

Anthropic and Google are not cosmetic variations on OpenAI:

- **Anthropic** hoists the system prompt out of the message list, models
  assistant tool calls as content blocks rather than a sibling field, requires
  `max_tokens`, and streams typed events (`message_start`,
  `content_block_delta`, `message_delta`) rather than uniform deltas.
- **Google** puts the model id in the URL path, calls assistant turns `model`,
  separates the system prompt into `systemInstruction`, and nests sampling
  parameters under `generationConfig`.

All of that is contained in the adapters. The tests assert the translation in
both directions, including streaming tool calls with stable indices across
content blocks.

## Error normalization

Every provider failure is mapped onto one normalized taxonomy before it leaves
the gateway, carrying two traits that drive everything downstream:

- `retryable` — safe to re-send to the _same_ provider
- `failoverable` — safe to re-send to a _different_ provider

```
invalid_request         400  no retry, no failover
authentication_error    401  no retry, no failover
permission_denied       403  no retry, no failover
model_not_allowed       403  no retry, no failover
model_not_found         404  no retry, no failover
budget_exceeded         402  no retry, no failover
rate_limit              429  no retry, no failover   (the gateway's own limit)
context_length_exceeded 400  no retry, no failover
content_filter          400  no retry, no failover
capability_unsupported  400  no retry, no failover

provider_rate_limit     429  retry + failover
provider_timeout        504  retry + failover
provider_unavailable    503  retry + failover
provider_overloaded     503  retry + failover
provider_error          502  retry + failover
circuit_open            503  failover only

no_route_available      503
fallback_exhausted      502
client_disconnected     499
internal_error          500
```

Adapters refine the generic HTTP mapping with vendor-specific codes. Two worth
calling out:

- A 400 for `context_length_exceeded` must not be retried; retrying cannot make
  the prompt shorter.
- A 429 for `insufficient_quota` means the provider is out of credit. Retrying
  cannot help, but failing over can — so it maps to `provider_unavailable`
  rather than `provider_rate_limit`.

Provider error _text_ never reaches the caller. It can echo the caller's own
prompt back, and at gateway scale that is a leak. The text is kept on the trace
for operators; the caller gets a normalized message.

## Writing an adapter

```ts
import { HttpClient, iterateSseJson } from '@ai-gateway/provider-sdk';
import type { AIProvider, ChatRequest, ProviderCallContext } from '@ai-gateway/core';

export class MyProvider implements AIProvider {
  readonly id = 'myvendor';
  readonly kind = 'myvendor';
  private http: HttpClient;

  constructor(opts: { apiKey: string; baseUrl: string; models: ModelDescriptor[] }) {
    // HttpClient owns deadline enforcement, error normalization and prompt
    // cancellation so every adapter does not reimplement them.
    this.http = new HttpClient({
      providerId: this.id,
      baseUrl: opts.baseUrl,
      headers: { authorization: `Bearer ${opts.apiKey}` },
    });
  }

  async chat(request: ChatRequest, ctx: ProviderCallContext) {
    const { body } = await this.http.requestJson({
      path: '/v1/generate',
      body: toMyWireFormat(request, ctx.model.providerModelId),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyMyVendorError, // refine the generic HTTP mapping
    });
    return fromMyWireFormat(body, ctx);
  }

  async *stream(request: ChatRequest, ctx: ProviderCallContext) {
    const response = await this.http.requestStream({/* … */});
    for await (const frame of iterateSseJson(response, ctx.signal)) {
      yield toChunk(frame, ctx);
    }
  }

  // …listModels, healthCheck
}
```

Three rules:

1. **Always report the gateway model id**, never the upstream one. Callers
   should not see a vendor's internal naming leak through.
2. **Honour `ctx.signal`.** It fires when the client disconnects or the deadline
   passes; ignoring it means paying for abandoned work.
3. **Never echo upstream error text** into the message. Classify it, and keep
   the raw detail on the cause for the trace.

## Custom providers at runtime

An administrator can register an OpenAI-compatible endpoint without a deploy:

```bash
curl -X POST $GATEWAY_URL/api/v1/providers \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{
    "id": "myvendor",
    "kind": "openai-compatible",
    "displayName": "My Vendor",
    "baseUrl": "https://api.myvendor.example/v1",
    "credentialValue": "sk-…",
    "models": [{"providerModelId": "small", "contextWindow": 32000, "capabilities": ["chat","streaming"]}]
  }'
```

The base URL is SSRF-checked before anything is stored, and the credential is
encrypted with AES-256-GCM bound to the provider id. See
[security.md](./security.md).

## Health

`healthCheck()` is a probe. Measured health — what routing actually uses — comes
from real traffic: success rate, error rate, timeout rate, rate-limit rate and
latency percentiles over a rolling window.

A target with too few samples is `unknown`, not `healthy`. Routing treats
unknown as unproven rather than penalising a provider that simply has not been
tried yet.

A credential rejection on a probe reports `degraded` rather than `unavailable`:
the endpoint is reachable and the problem is the operator's, which is a
different thing to tell someone than "the provider is down".
