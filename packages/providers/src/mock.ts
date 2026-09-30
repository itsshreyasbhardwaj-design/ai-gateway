import {
  GatewayError,
  estimateCompletionTokens,
  estimatePromptTokens,
  estimatedUsage,
  reportedUsage,
  type AIProvider,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type MeasuredUsage,
  type ModelDescriptor,
  type ProviderCallContext,
  type ProviderHealth,
} from '@ai-gateway/core';

/**
 * Development and test provider.
 *
 * This exists so the gateway is fully exercisable - routing, fallback, retries,
 * streaming, budgets, caching, traces - with no vendor credentials and no
 * network. It is deliberately, visibly synthetic:
 *
 *   - every completion is prefixed with `[mock:<model>]`
 *   - `MOCK_NOTICE` is exported and rendered anywhere mock output is displayed
 *   - it is registered under its own provider id (`mock`), never aliased onto
 *     a real vendor's id
 *
 * Nothing it returns should ever be mistaken for a real model's output, and the
 * dashboard flags any request served by it.
 */

export const MOCK_NOTICE =
  'Synthetic output from the AI Gateway mock provider. Not a real model response.';

export type MockFailureMode =
  | 'none'
  | 'rate_limit'
  | 'server_error'
  | 'timeout'
  | 'overloaded'
  | 'auth'
  | 'invalid_request'
  | 'mid_stream_error';

export interface MockBehavior {
  /** Simulated time-to-first-token / total latency, in ms. */
  latencyMs?: number;
  /** Delay between streamed chunks, in ms. */
  chunkDelayMs?: number;
  failureMode?: MockFailureMode;
  /** Fail this fraction of calls, 0..1. Deterministic given `seed`. */
  failureRate?: number;
  /** Fail only the first N calls, then recover. Drives circuit-breaker tests. */
  failFirstN?: number;
  seed?: number;
  /** Report usage as provider-reported (true) or leave it to the estimator. */
  reportUsage?: boolean;
}

export interface MockProviderOptions {
  id?: string;
  models?: ModelDescriptor[];
  behavior?: MockBehavior;
  /** Per-model behavior overrides, keyed by provider model id. */
  perModel?: Record<string, MockBehavior>;
  healthy?: boolean;
}

export const MOCK_MODELS: ModelDescriptor[] = [
  {
    id: 'mock/mock-fast',
    providerId: 'mock',
    providerModelId: 'mock-fast',
    displayName: 'Mock Fast (synthetic)',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: ['chat', 'streaming', 'tools', 'json-mode'],
    status: 'available',
    family: 'mock',
    description: 'Low-latency synthetic model for local development. Not a real model.',
  },
  {
    id: 'mock/mock-smart',
    providerId: 'mock',
    providerModelId: 'mock-smart',
    displayName: 'Mock Smart (synthetic)',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: [
      'chat',
      'streaming',
      'tools',
      'vision',
      'structured-output',
      'json-mode',
      'reasoning',
    ],
    status: 'available',
    family: 'mock',
    description: 'Higher-cost synthetic model for local development. Not a real model.',
  },
  {
    id: 'mock/mock-flaky',
    providerId: 'mock',
    providerModelId: 'mock-flaky',
    displayName: 'Mock Flaky (synthetic)',
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    capabilities: ['chat', 'streaming'],
    status: 'available',
    family: 'mock',
    description:
      'Fails a configurable share of requests so fallback and circuit breaking can be exercised.',
  },
  {
    id: 'mock/mock-embed',
    providerId: 'mock',
    providerModelId: 'mock-embed',
    displayName: 'Mock Embeddings (synthetic)',
    contextWindow: 8_192,
    capabilities: ['embeddings'],
    status: 'available',
    family: 'mock',
    description:
      'Deterministic hashed embeddings for local development. Not a real embedding model.',
  },
];

export class MockProvider implements AIProvider {
  readonly id: string;
  readonly kind = 'mock';
  private readonly models: ModelDescriptor[];
  private readonly behavior: MockBehavior;
  private readonly perModel: Record<string, MockBehavior>;
  private healthy: boolean;
  private callCounts = new Map<string, number>();

  constructor(opts: MockProviderOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.models = (opts.models ?? MOCK_MODELS).map((m) =>
      m.providerId === this.id
        ? m
        : { ...m, providerId: this.id, id: `${this.id}/${m.providerModelId}` },
    );
    this.behavior = { latencyMs: 5, chunkDelayMs: 1, reportUsage: true, ...opts.behavior };
    this.perModel = opts.perModel ?? {};
    this.healthy = opts.healthy ?? true;
  }

  /** Change behavior at runtime; used by the failover-simulation endpoint and tests. */
  setBehavior(modelId: string, behavior: MockBehavior): void {
    this.perModel[modelId] = { ...this.perModel[modelId], ...behavior };
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  resetCounters(): void {
    this.callCounts.clear();
  }

  callCount(modelId: string): number {
    return this.callCounts.get(modelId) ?? 0;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse> {
    const behavior = this.behaviorFor(ctx.model.providerModelId);
    const count = this.bump(ctx.model.providerModelId);
    await this.delay(behavior.latencyMs ?? 0, ctx.signal);
    this.maybeFail(behavior, count, ctx, false);

    const text = this.synthesize(request, ctx);
    return {
      id: ctx.requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model.id,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: this.usageFor(request, text, behavior),
    };
  }

  async *stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk> {
    const behavior = this.behaviorFor(ctx.model.providerModelId);
    const count = this.bump(ctx.model.providerModelId);
    await this.delay(behavior.latencyMs ?? 0, ctx.signal);
    this.maybeFail(behavior, count, ctx, true);

    const text = this.synthesize(request, ctx);
    const created = Math.floor(Date.now() / 1000);
    const frame = (
      delta: ChatChunk['choices'][number]['delta'],
      finish: ChatChunk['choices'][number]['finish_reason'] = null,
      usage?: MeasuredUsage,
    ): ChatChunk => ({
      id: ctx.requestId,
      object: 'chat.completion.chunk',
      created,
      model: ctx.model.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });

    yield frame({ role: 'assistant', content: '' });

    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (ctx.signal.aborted) {
        throw new GatewayError('client_disconnected', 'The client cancelled the request.');
      }
      if (behavior.failureMode === 'mid_stream_error' && i === Math.floor(words.length / 2)) {
        throw new GatewayError('provider_error', 'Mock provider failed mid-stream.', {
          provider: this.id,
          model: ctx.model.id,
        });
      }
      await this.delay(behavior.chunkDelayMs ?? 0, ctx.signal);
      yield frame({ content: i === 0 ? words[i] : ` ${words[i]}` });
    }

    yield frame({}, 'stop', this.usageFor(request, text, behavior));
  }

  async embed(request: EmbeddingsRequest, ctx: ProviderCallContext): Promise<EmbeddingsResponse> {
    const behavior = this.behaviorFor(ctx.model.providerModelId);
    const count = this.bump(ctx.model.providerModelId);
    await this.delay(behavior.latencyMs ?? 0, ctx.signal);
    this.maybeFail(behavior, count, ctx, false);

    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const dims = request.dimensions ?? 128;
    let inputTokens = 0;
    const data = inputs.map((text, index) => {
      inputTokens += estimateCompletionTokens(text);
      return { object: 'embedding' as const, index, embedding: hashEmbedding(text, dims) };
    });

    return {
      object: 'list',
      model: ctx.model.id,
      data,
      usage: reportedUsage({ input: inputTokens, output: 0, total: inputTokens }),
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      state: this.healthy ? 'healthy' : 'unavailable',
      latencyMs: 0,
      checkedAt: Date.now(),
      message: this.healthy ? MOCK_NOTICE : 'Mock provider was explicitly marked unhealthy.',
    };
  }

  private behaviorFor(providerModelId: string): MockBehavior {
    return { ...this.behavior, ...this.perModel[providerModelId] };
  }

  private bump(providerModelId: string): number {
    const next = (this.callCounts.get(providerModelId) ?? 0) + 1;
    this.callCounts.set(providerModelId, next);
    return next;
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new GatewayError('client_disconnected', 'The client cancelled the request.'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private maybeFail(
    behavior: MockBehavior,
    callNumber: number,
    ctx: ProviderCallContext,
    streaming: boolean,
  ): void {
    const opts = { provider: this.id, model: ctx.model.id };

    if (behavior.failFirstN !== undefined && callNumber <= behavior.failFirstN) {
      throw new GatewayError(
        'provider_unavailable',
        `Mock provider failing call ${callNumber} of first ${behavior.failFirstN}.`,
        opts,
      );
    }

    if (behavior.failureRate && behavior.failureRate > 0) {
      // Deterministic given (seed, model, call number) so tests never flake.
      const roll = deterministicUnit(`${behavior.seed ?? 0}:${ctx.model.id}:${callNumber}`);
      if (roll < behavior.failureRate) {
        throw new GatewayError('provider_error', 'Mock provider injected a random failure.', opts);
      }
    }

    const mode = behavior.failureMode ?? 'none';
    if (mode === 'none' || (mode === 'mid_stream_error' && streaming)) return;

    switch (mode) {
      case 'rate_limit':
        throw new GatewayError('provider_rate_limit', 'Mock provider rate limited this request.', {
          ...opts,
          retryAfterSeconds: 1,
        });
      case 'server_error':
        throw new GatewayError('provider_error', 'Mock provider returned a 500.', opts);
      case 'timeout':
        throw new GatewayError('provider_timeout', 'Mock provider timed out.', opts);
      case 'overloaded':
        throw new GatewayError('provider_overloaded', 'Mock provider is overloaded.', opts);
      case 'auth':
        throw new GatewayError(
          'authentication_error',
          "Mock provider rejected the gateway's credential.",
          opts,
        );
      case 'invalid_request':
        throw new GatewayError(
          'invalid_request',
          'Mock provider rejected the request as malformed.',
          opts,
        );
      case 'mid_stream_error':
        throw new GatewayError(
          'provider_error',
          'Mock provider failed before streaming started.',
          opts,
        );
    }
  }

  /**
   * Produce a response that is obviously synthetic but still useful for testing
   * - it echoes back enough of the prompt that a caller can tell routing worked.
   */
  private synthesize(request: ChatRequest, ctx: ProviderCallContext): string {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const prompt = flatten(lastUser?.content ?? '').slice(0, 280);
    return (
      `[mock:${ctx.model.id}] ${MOCK_NOTICE} ` +
      `Echoing the last user turn so routing and streaming can be verified: "${prompt}"`
    );
  }

  private usageFor(request: ChatRequest, text: string, behavior: MockBehavior): MeasuredUsage {
    const input = estimatePromptTokens(request.messages);
    const output = estimateCompletionTokens(text);
    return behavior.reportUsage
      ? reportedUsage({ input, output, total: input + output })
      : estimatedUsage(input, output);
  }
}

function flatten(content: string | ContentPart[] | null): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
}

/** FNV-1a derived unit float. Stable across runs and platforms. */
function deterministicUnit(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10000) / 10000;
}

/** Deterministic pseudo-embedding: same text always yields the same unit vector. */
function hashEmbedding(text: string, dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    const idx = (hash >>> 0) % dims;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}
