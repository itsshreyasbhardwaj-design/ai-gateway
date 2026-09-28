import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@ai-gateway/core';
import { AnthropicProvider } from './anthropic.js';
import { collect, stubFetch, testCallContext, testModel } from './testing.js';

const model = testModel({
  id: 'anthropic/claude-x',
  providerId: 'anthropic',
  providerModelId: 'claude-x-20250101',
  maxOutputTokens: 8_192,
});

function provider(stub: ReturnType<typeof stubFetch>) {
  return new AnthropicProvider({ apiKey: 'sk-ant-test-key-value', models: [model], fetchImpl: stub.fetch });
}

const ok = {
  json: {
    id: 'msg_1',
    content: [{ type: 'text', text: 'Hello there' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 3 },
  },
};

describe('AnthropicProvider - request translation', () => {
  it('hoists system turns into the top-level system field', async () => {
    const stub = stubFetch(ok);
    const request: ChatRequest = {
      model: 'anthropic/claude-x',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'system', content: 'You answer in English.' },
        { role: 'user', content: 'Hi' },
      ],
    };
    await provider(stub).chat(request, testCallContext({ model }));

    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body['system']).toBe('You are terse.\n\nYou answer in English.');
    expect(body['messages']).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('always sends max_tokens, which Anthropic requires', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      { model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] },
      testCallContext({ model }),
    );
    expect((stub.calls[0]?.body as Record<string, unknown>)['max_tokens']).toBeTypeOf('number');
  });

  it('sends the api key in x-api-key with a pinned api version', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(stub.calls[0]?.headers['x-api-key']).toBe('sk-ant-test-key-value');
    expect(stub.calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(stub.calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('converts a tool result turn into a tool_result content block', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      {
        model: 'anthropic/claude-x',
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } }] },
          { role: 'tool', tool_call_id: 'toolu_1', content: '31C' },
        ],
      },
      testCallContext({ model }),
    );

    const messages = (stub.calls[0]?.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Pune' } }],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '31C' }],
    });
  });

  it('rewrites OpenAI tool definitions into input_schema form', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      {
        model: 'anthropic/claude-x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'required',
      },
      testCallContext({ model }),
    );
    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body['tools']).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }]);
    expect(body['tool_choice']).toEqual({ type: 'any' });
  });

  it('converts a base64 data URL image into an inline source block', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      {
        model: 'anthropic/claude-x',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
      },
      testCallContext({ model }),
    );
    const messages = (stub.calls[0]?.body as { messages: Array<{ content: unknown }> }).messages;
    expect(messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('maps stop_sequences from the OpenAI stop parameter', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      { model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'hi' }], stop: 'END' },
      testCallContext({ model }),
    );
    expect((stub.calls[0]?.body as Record<string, unknown>)['stop_sequences']).toEqual(['END']);
  });
});

describe('AnthropicProvider - response translation', () => {
  it('returns an OpenAI-shaped completion', async () => {
    const res = await provider(stubFetch(ok)).chat(
      { model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] },
      testCallContext({ model }),
    );
    expect(res.object).toBe('chat.completion');
    expect(res.model).toBe('anthropic/claude-x');
    expect(res.choices[0]?.message.content).toBe('Hello there');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage).toMatchObject({ input: 12, output: 3, total: 15, source: 'provider_reported' });
  });

  it('lifts tool_use blocks into tool_calls', async () => {
    const stub = stubFetch({
      json: {
        id: 'msg_2',
        content: [{ type: 'tool_use', id: 'toolu_9', name: 'lookup', input: { q: 'x' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 8 },
      },
    });
    const res = await provider(stub).chat({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
    expect(res.choices[0]?.message.tool_calls).toEqual([
      { id: 'toolu_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
    ]);
    expect(res.choices[0]?.message.content).toBeNull();
  });

  it('maps max_tokens to a length finish reason', async () => {
    const stub = stubFetch({ json: { content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' } });
    const res = await provider(stub).chat({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(res.choices[0]?.finish_reason).toBe('length');
  });

  it('counts cache-read tokens toward input and records them separately', async () => {
    const stub = stubFetch({
      json: {
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 },
      },
    });
    const res = await provider(stub).chat({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(res.usage).toMatchObject({ input: 100, cachedInput: 90, output: 5 });
  });
});

describe('AnthropicProvider - streaming', () => {
  it('flattens typed events into OpenAI-shaped deltas', async () => {
    const stub = stubFetch({
      sse: [
        { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
    });

    const chunks = await collect(
      provider(stub).stream({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }], stream: true }, testCallContext({ model })),
    );

    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello');
    const final = chunks[chunks.length - 1];
    expect(final?.choices[0]?.finish_reason).toBe('stop');
    expect(final?.usage).toMatchObject({ input: 9, output: 2, source: 'provider_reported' });
  });

  it('streams tool calls with stable indices across blocks', async () => {
    const stub = stubFetch({
      sse: [
        { type: 'message_start', message: { usage: { input_tokens: 4 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'f' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
        { type: 'message_stop' },
      ],
    });

    const chunks = await collect(
      provider(stub).stream({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }], stream: true }, testCallContext({ model })),
    );

    const toolChunks = chunks.filter((c) => c.choices[0]?.delta.tool_calls);
    expect(toolChunks[0]?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({ index: 0, id: 'toolu_a', function: { name: 'f' } });
    const args = toolChunks.map((c) => c.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? '').join('');
    expect(args).toBe('{"a":1}');
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('raises overloaded from an in-stream error event', async () => {
    const stub = stubFetch({
      sse: [
        { type: 'message_start', message: {} },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ],
    });
    await expect(
      collect(provider(stub).stream({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }], stream: true }, testCallContext({ model }))),
    ).rejects.toMatchObject({ type: 'provider_overloaded', retryable: true });
  });
});

describe('AnthropicProvider - error normalization', () => {
  const cases: Array<[number, string, string]> = [
    [429, 'rate_limit_error', 'provider_rate_limit'],
    [529, 'overloaded_error', 'provider_overloaded'],
    [401, 'authentication_error', 'authentication_error'],
    [403, 'permission_error', 'permission_denied'],
    [404, 'not_found_error', 'model_not_found'],
    [413, 'request_too_large', 'payload_too_large'],
    [500, 'api_error', 'provider_error'],
  ];

  for (const [status, type, expected] of cases) {
    it(`maps ${type} to ${expected}`, async () => {
      const stub = stubFetch({ status, json: { type: 'error', error: { type, message: 'x' } } });
      await expect(
        provider(stub).chat({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model })),
      ).rejects.toMatchObject({ type: expected });
    });
  }

  it('detects a context-window overflow from the message text', async () => {
    const stub = stubFetch({
      status: 400,
      json: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' } },
    });
    await expect(
      provider(stub).chat({ model: 'anthropic/claude-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model })),
    ).rejects.toMatchObject({ type: 'context_length_exceeded', retryable: false });
  });
});
