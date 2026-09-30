import { describe, expect, it } from 'vitest';
import { type GatewayError, type ChatRequest } from '@ai-gateway/core';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { collect, stubFetch, testCallContext, testModel } from './testing.js';

const model = testModel({
  id: 'acme/model-a',
  providerId: 'acme',
  providerModelId: 'upstream-model-a',
});

function provider(stub: ReturnType<typeof stubFetch>) {
  return new OpenAICompatibleProvider({
    id: 'acme',
    baseUrl: 'https://api.acme.example/v1',
    apiKey: 'sk-test-secret-value-1234567890',
    models: [model],
    fetchImpl: stub.fetch,
  });
}

const request: ChatRequest = {
  model: 'acme/model-a',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello' },
  ],
  temperature: 0.2,
  max_tokens: 100,
};

describe('OpenAICompatibleProvider - non-streaming', () => {
  it('sends the upstream model id, not the gateway id', async () => {
    const stub = stubFetch({
      json: {
        id: 'chatcmpl-1',
        created: 1,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    });
    await provider(stub).chat(request, testCallContext({ model }));

    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body['model']).toBe('upstream-model-a');
    expect(body['temperature']).toBe(0.2);
    expect(body['max_tokens']).toBe(100);
    expect(body['stream']).toBe(false);
    expect(stub.calls[0]?.url).toBe('https://api.acme.example/v1/chat/completions');
  });

  it('authenticates with a bearer token', async () => {
    const stub = stubFetch({
      json: {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
      },
    });
    await provider(stub).chat(request, testCallContext({ model }));
    expect(stub.calls[0]?.headers['authorization']).toBe('Bearer sk-test-secret-value-1234567890');
  });

  it('returns the gateway model id so callers never see the upstream name', async () => {
    const stub = stubFetch({
      json: {
        model: 'upstream-model-a-2024',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
      },
    });
    const res = await provider(stub).chat(request, testCallContext({ model }));
    expect(res.model).toBe('acme/model-a');
  });

  it('marks provider-reported usage as such and carries cached tokens', async () => {
    const stub = stubFetch({
      json: {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      },
    });
    const res = await provider(stub).chat(request, testCallContext({ model }));
    expect(res.usage).toMatchObject({
      input: 100,
      output: 20,
      total: 120,
      cachedInput: 64,
      source: 'provider_reported',
    });
  });

  it('maps a legacy function_call finish reason onto tool_calls', async () => {
    const stub = stubFetch({
      json: {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null },
            finish_reason: 'function_call',
          },
        ],
      },
    });
    const res = await provider(stub).chat(request, testCallContext({ model }));
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('errors rather than inventing a response when the upstream returns no choices', async () => {
    const stub = stubFetch({ json: { choices: [] } });
    await expect(provider(stub).chat(request, testCallContext({ model }))).rejects.toThrow(
      /no choices/,
    );
  });

  it('omits parameters the caller did not set', async () => {
    const stub = stubFetch({
      json: {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
      },
    });
    await provider(stub).chat(
      { model: 'acme/model-a', messages: [{ role: 'user', content: 'x' }] },
      testCallContext({ model }),
    );
    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
    expect('seed' in body).toBe(false);
  });
});

describe('OpenAICompatibleProvider - streaming', () => {
  it('translates deltas and asks for usage on the final chunk', async () => {
    const stub = stubFetch({
      sse: [
        {
          id: 'c1',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        },
        { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
        { id: 'c1', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
        {
          id: 'c1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ],
    });

    const chunks = await collect(
      provider(stub).stream({ ...request, stream: true }, testCallContext({ model })),
    );

    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello world');
    expect(chunks[3]?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks[3]?.usage).toMatchObject({ input: 5, output: 2, source: 'provider_reported' });

    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  it('reassembles events split across transport chunk boundaries', async () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      choices: [{ index: 0, delta: { content: `tok${i} ` }, finish_reason: null }],
    }));
    const stub = stubFetch({ sse: events });
    const chunks = await collect(
      provider(stub).stream({ ...request, stream: true }, testCallContext({ model })),
    );
    expect(chunks).toHaveLength(30);
    expect(chunks[29]?.choices[0]?.delta.content).toBe('tok29 ');
  });

  it('stops cleanly at [DONE] without emitting it as a chunk', async () => {
    const stub = stubFetch({
      sseRaw:
        'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    });
    const chunks = await collect(
      provider(stub).stream({ ...request, stream: true }, testCallContext({ model })),
    );
    expect(chunks).toHaveLength(1);
  });

  it('surfaces an error object embedded in the stream', async () => {
    const stub = stubFetch({
      sse: [
        { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] },
        { error: { message: 'upstream exploded', type: 'server_error' } },
      ],
    });
    await expect(
      collect(provider(stub).stream({ ...request, stream: true }, testCallContext({ model }))),
    ).rejects.toThrow(/error mid-stream/);
  });

  it('propagates a non-200 on the streaming request as a classified error', async () => {
    const stub = stubFetch({ status: 429, json: { error: { code: 'rate_limit_exceeded' } } });
    await expect(
      collect(provider(stub).stream({ ...request, stream: true }, testCallContext({ model }))),
    ).rejects.toMatchObject({ type: 'provider_rate_limit', retryable: true });
  });
});

describe('OpenAICompatibleProvider - error normalization', () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [401, { error: { code: 'invalid_api_key' } }, 'authentication_error', false],
    [403, { error: { code: 'permission_denied' } }, 'permission_denied', false],
    [404, { error: { code: 'model_not_found' } }, 'model_not_found', false],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'provider_rate_limit', true],
    [429, { error: { code: 'insufficient_quota' } }, 'provider_unavailable', true],
    [500, { error: { message: 'boom' } }, 'provider_error', true],
    [503, { error: { message: 'Engine overloaded' } }, 'provider_overloaded', true],
    [400, { error: { code: 'context_length_exceeded' } }, 'context_length_exceeded', false],
    [400, { error: { code: 'content_filter' } }, 'content_filter', false],
    [400, { error: { message: 'bad parameter' } }, 'invalid_request', false],
  ];

  for (const [status, body, expectedType, retryable] of cases) {
    it(`maps HTTP ${status} ${JSON.stringify(body)} to ${expectedType}`, async () => {
      const stub = stubFetch({ status, json: body });
      await expect(provider(stub).chat(request, testCallContext({ model }))).rejects.toMatchObject({
        type: expectedType,
        retryable,
      });
    });
  }

  it('never echoes the upstream error text into the user-facing message', async () => {
    const stub = stubFetch({
      status: 400,
      json: { error: { message: 'Your prompt contained: my-secret-customer-data' } },
    });
    const err = await provider(stub)
      .chat(request, testCallContext({ model }))
      .catch((e) => e as GatewayError);
    expect(err.message).not.toContain('my-secret-customer-data');
  });

  it('parses retry-after into seconds', async () => {
    const stub = stubFetch({ status: 429, json: { error: {} }, headers: { 'retry-after': '30' } });
    await expect(provider(stub).chat(request, testCallContext({ model }))).rejects.toMatchObject({
      retryAfterSeconds: 30,
    });
  });

  it('classifies DNS and connection failures as provider_unavailable', async () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET']) {
      const stub = stubFetch({ networkError: code });
      await expect(provider(stub).chat(request, testCallContext({ model }))).rejects.toMatchObject({
        type: 'provider_unavailable',
      });
    }
  });

  it('turns an exceeded deadline into provider_timeout', async () => {
    const stub = stubFetch({ hang: true });
    await expect(
      provider(stub).chat(request, testCallContext({ model, timeoutMs: 20 })),
    ).rejects.toMatchObject({ type: 'provider_timeout', retryable: true });
  });

  it('distinguishes client cancellation from a timeout', async () => {
    const controller = new AbortController();
    const stub = stubFetch({ hang: true });
    const promise = provider(stub).chat(
      request,
      testCallContext({ model, signal: controller.signal, timeoutMs: 5_000 }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ type: 'client_disconnected' });
  });
});

describe('OpenAICompatibleProvider - health', () => {
  it('reports healthy when the discovery endpoint answers', async () => {
    const stub = stubFetch({ json: { data: [] } });
    const health = await provider(stub).healthCheck();
    expect(health.state).toBe('healthy');
    expect(stub.calls[0]?.url).toBe('https://api.acme.example/v1/models');
  });

  it('reports degraded (not unavailable) when the credential is rejected', async () => {
    const stub = stubFetch({ status: 401, json: { error: { code: 'invalid_api_key' } } });
    expect((await provider(stub).healthCheck()).state).toBe('degraded');
  });

  it('reports unavailable when the host is unreachable', async () => {
    const stub = stubFetch({ networkError: 'ECONNREFUSED' });
    expect((await provider(stub).healthCheck()).state).toBe('unavailable');
  });
});
