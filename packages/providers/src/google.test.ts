import { describe, expect, it } from 'vitest';
import { GoogleProvider } from './google.js';
import { collect, stubFetch, testCallContext, testModel } from './testing.js';

const model = testModel({
  id: 'google/gemini-x',
  providerId: 'google',
  providerModelId: 'gemini-x',
  capabilities: ['chat', 'streaming', 'tools', 'vision'],
});

function provider(stub: ReturnType<typeof stubFetch>) {
  return new GoogleProvider({ apiKey: 'AIza-test-key', models: [model], fetchImpl: stub.fetch });
}

const ok = {
  json: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'Hi there' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
  },
};

describe('GoogleProvider - request translation', () => {
  it('puts the model in the URL path and keeps the key in a header', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat({ model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(stub.calls[0]?.url).toContain('/models/gemini-x:generateContent');
    expect(stub.calls[0]?.headers['x-goog-api-key']).toBe('AIza-test-key');
    // A key in the query string ends up in proxy logs; it must not be there.
    expect(stub.calls[0]?.url).not.toContain('key=');
  });

  it('separates the system prompt into systemInstruction', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      {
        model: 'google/gemini-x',
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Hi' },
        ],
      },
      testCallContext({ model }),
    );
    const body = stub.calls[0]?.body as Record<string, unknown>;
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
  });

  it('renames the assistant role to model', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      {
        model: 'google/gemini-x',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ],
      },
      testCallContext({ model }),
    );
    const contents = (stub.calls[0]?.body as { contents: Array<{ role: string }> }).contents;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('moves sampling parameters into generationConfig', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      { model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.4, max_tokens: 256, stop: ['X'] },
      testCallContext({ model }),
    );
    expect((stub.calls[0]?.body as Record<string, unknown>)['generationConfig']).toEqual({
      temperature: 0.4,
      maxOutputTokens: 256,
      stopSequences: ['X'],
    });
  });

  it('maps a json_schema response format onto responseSchema', async () => {
    const stub = stubFetch(ok);
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await provider(stub).chat(
      {
        model: 'google/gemini-x',
        messages: [{ role: 'user', content: 'Hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'out', schema } },
      },
      testCallContext({ model }),
    );
    const cfg = (stub.calls[0]?.body as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg['responseMimeType']).toBe('application/json');
    expect(cfg['responseSchema']).toEqual(schema);
  });

  it('wraps tool declarations in the functionDeclarations envelope', async () => {
    const stub = stubFetch(ok);
    await provider(stub).chat(
      {
        model: 'google/gemini-x',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
      },
      testCallContext({ model }),
    );
    expect((stub.calls[0]?.body as Record<string, unknown>)['tools']).toEqual([
      { functionDeclarations: [{ name: 'f', description: undefined, parameters: { type: 'object', properties: {} } }] },
    ]);
  });
});

describe('GoogleProvider - response translation', () => {
  it('returns an OpenAI-shaped completion with normalized usage', async () => {
    const res = await provider(stubFetch(ok)).chat(
      { model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }] },
      testCallContext({ model }),
    );
    expect(res.choices[0]?.message.content).toBe('Hi there');
    expect(res.choices[0]?.finish_reason).toBe('stop');
    expect(res.usage).toMatchObject({ input: 7, output: 2, total: 9, source: 'provider_reported' });
  });

  it('maps a SAFETY finish reason to content_filter', async () => {
    const stub = stubFetch({ json: { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] } });
    const res = await provider(stub).chat({ model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(res.choices[0]?.finish_reason).toBe('content_filter');
  });

  it('converts functionCall parts into tool_calls', async () => {
    const stub = stubFetch({
      json: {
        candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
      },
    });
    const res = await provider(stub).chat({ model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model }));
    expect(res.choices[0]?.message.tool_calls?.[0]?.function).toEqual({ name: 'lookup', arguments: '{"q":"x"}' });
  });

  it('errors rather than fabricating output when no candidate comes back', async () => {
    await expect(
      provider(stubFetch({ json: { candidates: [] } })).chat(
        { model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }] },
        testCallContext({ model }),
      ),
    ).rejects.toThrow(/no candidates/);
  });
});

describe('GoogleProvider - streaming', () => {
  it('emits a role frame then text deltas then a finish frame', async () => {
    const stub = stubFetch({
      sse: [
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'lo' }] } }] },
        { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } },
      ],
    });
    const chunks = await collect(
      provider(stub).stream({ model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }], stream: true }, testCallContext({ model })),
    );
    expect(stub.calls[0]?.url).toContain(':streamGenerateContent?alt=sse');
    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello');
    expect(chunks[chunks.length - 1]?.usage).toMatchObject({ input: 3, output: 2 });
  });
});

describe('GoogleProvider - error normalization', () => {
  const cases: Array<[number, string, string]> = [
    [429, 'RESOURCE_EXHAUSTED', 'provider_rate_limit'],
    [503, 'UNAVAILABLE', 'provider_unavailable'],
    [504, 'DEADLINE_EXCEEDED', 'provider_timeout'],
    [403, 'PERMISSION_DENIED', 'permission_denied'],
    [401, 'UNAUTHENTICATED', 'authentication_error'],
    [404, 'NOT_FOUND', 'model_not_found'],
  ];
  for (const [status, googleStatus, expected] of cases) {
    it(`maps ${googleStatus} to ${expected}`, async () => {
      const stub = stubFetch({ status, json: { error: { status: googleStatus, message: 'x' } } });
      await expect(
        provider(stub).chat({ model: 'google/gemini-x', messages: [{ role: 'user', content: 'Hi' }] }, testCallContext({ model })),
      ).rejects.toMatchObject({ type: expected });
    });
  }
});
