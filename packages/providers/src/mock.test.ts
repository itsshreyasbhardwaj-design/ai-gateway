import { describe, expect, it } from 'vitest';
import { MockProvider, MOCK_MODELS, MOCK_NOTICE } from './mock.js';
import { collect, testCallContext } from './testing.js';

const model = MOCK_MODELS[0]!;
const ctx = () => testCallContext({ model });
const request = { model: model.id, messages: [{ role: 'user' as const, content: 'ping' }] };

describe('MockProvider', () => {
  it('labels every completion as synthetic', async () => {
    const res = await new MockProvider().chat(request, ctx());
    const content = res.choices[0]?.message.content as string;
    expect(content).toContain(MOCK_NOTICE);
    expect(content).toContain(`[mock:${model.id}]`);
  });

  it('never registers itself under a real vendor id by default', () => {
    expect(new MockProvider().id).toBe('mock');
    expect(MOCK_MODELS.every((m) => m.providerId === 'mock')).toBe(true);
  });

  it('streams the same text it would return non-streamed', async () => {
    const provider = new MockProvider({ behavior: { chunkDelayMs: 0 } });
    const streamed = await collect(provider.stream(request, ctx()));
    const text = streamed.map((c) => c.choices[0]?.delta.content ?? '').join('');
    const direct = (await provider.chat(request, ctx())).choices[0]?.message.content as string;
    expect(text.trim()).toBe(direct.trim());
    expect(streamed[streamed.length - 1]?.usage?.total).toBeGreaterThan(0);
  });

  it('injects each failure mode as the matching normalized error', async () => {
    const cases: Array<[string, string]> = [
      ['rate_limit', 'provider_rate_limit'],
      ['server_error', 'provider_error'],
      ['timeout', 'provider_timeout'],
      ['overloaded', 'provider_overloaded'],
      ['auth', 'authentication_error'],
      ['invalid_request', 'invalid_request'],
    ];
    for (const [mode, expected] of cases) {
      const provider = new MockProvider({ behavior: { failureMode: mode as never, latencyMs: 0 } });
      await expect(provider.chat(request, ctx())).rejects.toMatchObject({ type: expected });
    }
  });

  it('fails only the first N calls so recovery can be tested', async () => {
    const provider = new MockProvider({ behavior: { failFirstN: 2, latencyMs: 0 } });
    await expect(provider.chat(request, ctx())).rejects.toThrow();
    await expect(provider.chat(request, ctx())).rejects.toThrow();
    await expect(provider.chat(request, ctx())).resolves.toBeDefined();
  });

  it('applies a deterministic failure rate', async () => {
    const run = async () => {
      const provider = new MockProvider({ behavior: { failureRate: 0.5, seed: 42, latencyMs: 0 } });
      const outcomes: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        outcomes.push(
          await provider.chat(request, ctx()).then(
            () => true,
            () => false,
          ),
        );
      }
      return outcomes;
    };
    expect(await run()).toEqual(await run());
  });

  it('fails mid-stream when asked, after emitting some content', async () => {
    const provider = new MockProvider({
      behavior: { failureMode: 'mid_stream_error', chunkDelayMs: 0, latencyMs: 0 },
    });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of provider.stream(request, ctx())) {
          seen.push(chunk.choices[0]?.delta.content ?? '');
        }
      })(),
    ).rejects.toMatchObject({ type: 'provider_error' });
    expect(seen.join('').length).toBeGreaterThan(0);
  });

  it('honours client cancellation mid-stream', async () => {
    const provider = new MockProvider({ behavior: { chunkDelayMs: 5, latencyMs: 0 } });
    const controller = new AbortController();
    const iter = provider.stream(request, testCallContext({ model, signal: controller.signal }));
    const consume = (async () => {
      for await (const _chunk of iter) {
        controller.abort();
      }
    })();
    await expect(consume).rejects.toMatchObject({ type: 'client_disconnected' });
  });

  it('returns deterministic normalized embeddings', async () => {
    const provider = new MockProvider();
    const embedCtx = testCallContext({ model: MOCK_MODELS[3]! });
    const a = await provider.embed!({ model: 'mock/mock-embed', input: 'hello' }, embedCtx);
    const b = await provider.embed!({ model: 'mock/mock-embed', input: 'hello' }, embedCtx);
    const c = await provider.embed!({ model: 'mock/mock-embed', input: 'goodbye' }, embedCtx);
    expect(a.data[0]?.embedding).toEqual(b.data[0]?.embedding);
    expect(a.data[0]?.embedding).not.toEqual(c.data[0]?.embedding);
    const norm = Math.hypot(...(a.data[0]?.embedding ?? []));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('can be marked unhealthy at runtime', async () => {
    const provider = new MockProvider();
    expect((await provider.healthCheck()).state).toBe('healthy');
    provider.setHealthy(false);
    expect((await provider.healthCheck()).state).toBe('unavailable');
  });

  it('applies per-model behaviour overrides', async () => {
    const provider = new MockProvider({
      perModel: { 'mock-flaky': { failureMode: 'rate_limit' } },
      behavior: { latencyMs: 0 },
    });
    await expect(provider.chat(request, ctx())).resolves.toBeDefined();
    await expect(
      provider.chat(
        { model: 'mock/mock-flaky', messages: request.messages },
        testCallContext({ model: MOCK_MODELS[2]! }),
      ),
    ).rejects.toMatchObject({ type: 'provider_rate_limit' });
  });
});
