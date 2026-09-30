import {
  GatewayError,
  reportedUsage,
  type AIProvider,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type GatewayErrorType,
  type MeasuredUsage,
  type ModelDescriptor,
  type ProviderCallContext,
  type ProviderHealth,
} from '@ai-gateway/core';
import { HttpClient, iterateSseJson } from '@ai-gateway/provider-sdk';

export interface OpenAICompatibleOptions {
  id: string;
  /** Human label, e.g. "OpenAI" or "Self-hosted vLLM". */
  displayName?: string;
  baseUrl: string;
  apiKey?: string;
  /** Header the endpoint expects the key in. Defaults to `Authorization: Bearer`. */
  authHeader?: string;
  authScheme?: string;
  headers?: Record<string, string>;
  models: ModelDescriptor[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Ask the upstream to include usage on the final streaming chunk. */
  streamUsage?: boolean;
  /** Endpoint used by `healthCheck`. Defaults to `/models`. */
  healthPath?: string;
  kind?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Adapter for any endpoint that speaks the OpenAI chat-completions wire format.
 *
 * That covers OpenAI itself, OpenRouter, Together, Groq, Fireworks, vLLM,
 * Ollama's compat endpoint, LM Studio, and most "bring your own base URL"
 * deployments - which is why it is the workhorse adapter rather than a
 * vendor-specific one.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  private readonly http: HttpClient;
  private readonly models: ModelDescriptor[];
  private readonly streamUsage: boolean;
  private readonly healthPath: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.kind = opts.kind ?? 'openai-compatible';
    this.displayName = opts.displayName ?? opts.id;
    this.models = opts.models;
    this.streamUsage = opts.streamUsage ?? true;
    this.healthPath = opts.healthPath ?? '/models';
    this.defaultTimeoutMs = opts.timeoutMs ?? 60_000;

    const headers: Record<string, string> = { ...opts.headers };
    if (opts.apiKey) {
      const header = opts.authHeader ?? 'authorization';
      const scheme = opts.authScheme ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '');
      headers[header] = `${scheme}${opts.apiKey}`;
    }

    this.http = new HttpClient({
      providerId: opts.id,
      baseUrl: opts.baseUrl,
      headers,
      defaultTimeoutMs: this.defaultTimeoutMs,
      fetchImpl: opts.fetchImpl,
    });
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse> {
    const { body } = await this.http.requestJson<Record<string, unknown>>({
      path: '/chat/completions',
      body: this.toWire(request, ctx, false),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyOpenAIError,
    });
    return this.fromWire(body, ctx);
  }

  async *stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk> {
    const response = await this.http.requestStream({
      path: '/chat/completions',
      body: this.toWire(request, ctx, true),
      headers: { accept: 'text/event-stream' },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyOpenAIError,
    });

    for await (const raw of iterateSseJson<Record<string, unknown>>(response, ctx.signal)) {
      // Some gateways surface mid-stream failures as an `error` object rather
      // than an HTTP status, so the stream has to be inspected, not just piped.
      const inlineError = raw['error'];
      if (inlineError) {
        throw new GatewayError('provider_error', 'Provider reported an error mid-stream.', {
          provider: this.id,
          model: ctx.model.id,
          cause: inlineError,
        });
      }
      yield this.chunkFromWire(raw, ctx);
    }
  }

  async embed(request: EmbeddingsRequest, ctx: ProviderCallContext): Promise<EmbeddingsResponse> {
    const { body } = await this.http.requestJson<{
      data?: Array<{ index: number; embedding: number[] }>;
      usage?: OpenAIUsage;
    }>({
      path: '/embeddings',
      body: {
        model: ctx.model.providerModelId,
        input: request.input,
        ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        ...(request.encoding_format ? { encoding_format: request.encoding_format } : {}),
      },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyOpenAIError,
    });

    return {
      object: 'list',
      model: ctx.model.id,
      data: (body.data ?? []).map((d) => ({
        object: 'embedding' as const,
        index: d.index,
        embedding: d.embedding,
      })),
      usage: body.usage ? toUsage(body.usage) : undefined,
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.http.requestJson({
        path: this.healthPath,
        method: 'GET',
        signal,
        timeoutMs: Math.min(this.defaultTimeoutMs, 10_000),
      });
      return {
        providerId: this.id,
        state: 'healthy',
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
      };
    } catch (err) {
      const gwErr = GatewayError.from(err);
      // A 401/403 on the probe means the endpoint is reachable but our
      // credential is wrong - an operator problem, not an outage.
      const state =
        gwErr.type === 'authentication_error' || gwErr.type === 'permission_denied'
          ? 'degraded'
          : 'unavailable';
      return {
        providerId: this.id,
        state,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        message: gwErr.message,
      };
    }
  }

  private toWire(
    request: ChatRequest,
    ctx: ProviderCallContext,
    stream: boolean,
  ): Record<string, unknown> {
    const maxTokens = request.max_completion_tokens ?? request.max_tokens;
    const wire: Record<string, unknown> = {
      model: ctx.model.providerModelId,
      messages: request.messages,
      stream,
    };
    if (stream && this.streamUsage) wire['stream_options'] = { include_usage: true };
    if (request.temperature !== undefined) wire['temperature'] = request.temperature;
    if (request.top_p !== undefined) wire['top_p'] = request.top_p;
    if (maxTokens !== undefined) wire['max_tokens'] = maxTokens;
    if (request.stop !== undefined) wire['stop'] = request.stop;
    if (request.n !== undefined) wire['n'] = request.n;
    if (request.presence_penalty !== undefined) wire['presence_penalty'] = request.presence_penalty;
    if (request.frequency_penalty !== undefined)
      wire['frequency_penalty'] = request.frequency_penalty;
    if (request.seed !== undefined) wire['seed'] = request.seed;
    if (request.tools) wire['tools'] = request.tools;
    if (request.tool_choice !== undefined) wire['tool_choice'] = request.tool_choice;
    if (request.response_format) wire['response_format'] = request.response_format;
    if (request.user) wire['user'] = request.user;
    return wire;
  }

  private fromWire(body: Record<string, unknown>, ctx: ProviderCallContext): ChatResponse {
    const choices = Array.isArray(body['choices'])
      ? (body['choices'] as Array<Record<string, unknown>>)
      : [];
    if (choices.length === 0) {
      throw new GatewayError('provider_error', 'Provider returned no choices.', {
        provider: this.id,
        model: ctx.model.id,
      });
    }
    return {
      id: typeof body['id'] === 'string' ? body['id'] : ctx.requestId,
      object: 'chat.completion',
      created:
        typeof body['created'] === 'number' ? body['created'] : Math.floor(Date.now() / 1000),
      // Always report the gateway-namespaced model id, not the upstream's.
      model: ctx.model.id,
      choices: choices.map((c, index) => ({
        index: typeof c['index'] === 'number' ? c['index'] : index,
        message: (c['message'] ?? {
          role: 'assistant',
          content: '',
        }) as ChatResponse['choices'][number]['message'],
        finish_reason: normalizeFinishReason(c['finish_reason']),
      })),
      usage: body['usage'] ? toUsage(body['usage'] as OpenAIUsage) : undefined,
    };
  }

  private chunkFromWire(raw: Record<string, unknown>, ctx: ProviderCallContext): ChatChunk {
    const choices = Array.isArray(raw['choices'])
      ? (raw['choices'] as Array<Record<string, unknown>>)
      : [];
    return {
      id: typeof raw['id'] === 'string' ? raw['id'] : ctx.requestId,
      object: 'chat.completion.chunk',
      created: typeof raw['created'] === 'number' ? raw['created'] : Math.floor(Date.now() / 1000),
      model: ctx.model.id,
      choices: choices.map((c, index) => ({
        index: typeof c['index'] === 'number' ? c['index'] : index,
        delta: (c['delta'] ?? {}) as ChatChunk['choices'][number]['delta'],
        finish_reason: normalizeFinishReason(c['finish_reason']),
      })),
      usage: raw['usage'] ? toUsage(raw['usage'] as OpenAIUsage) : undefined,
    };
  }
}

function toUsage(usage: OpenAIUsage): MeasuredUsage {
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const measured = reportedUsage({
    input,
    output,
    total: usage.total_tokens ?? input + output,
  });
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached) measured.cachedInput = cached;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning) measured.reasoning = reasoning;
  return measured;
}

function normalizeFinishReason(value: unknown): ChatResponse['choices'][number]['finish_reason'] {
  switch (value) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return value;
    case 'function_call':
      return 'tool_calls';
    case null:
    case undefined:
      return null;
    default:
      return 'stop';
  }
}

/**
 * Refine the generic HTTP classification using OpenAI's error `code`/`type`.
 * A 400 for "context_length_exceeded" must not be retried; a 429 for
 * "insufficient_quota" must not be either, because retrying a billing failure
 * only burns latency.
 */
export function classifyOpenAIError(status: number, body: unknown): GatewayErrorType | undefined {
  const err = (body as { error?: { code?: string; type?: string; message?: string } } | undefined)
    ?.error;
  const code = (err?.code ?? err?.type ?? '').toLowerCase();
  const message = (err?.message ?? '').toLowerCase();

  if (
    code.includes('context_length') ||
    message.includes('context length') ||
    message.includes('maximum context')
  ) {
    return 'context_length_exceeded';
  }
  if (code.includes('content_filter') || code.includes('content_policy')) return 'content_filter';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    // Out of credit at the provider. Retrying cannot help; failing over can.
    return 'provider_unavailable';
  }
  if (code === 'model_not_found' || code === 'model_not_available') return 'model_not_found';
  if (code === 'invalid_api_key' || (code === 'invalid_request_error' && status === 401)) {
    return 'authentication_error';
  }
  if (status === 429 && code === 'rate_limit_exceeded') return 'provider_rate_limit';
  if (status === 503 && message.includes('overloaded')) return 'provider_overloaded';
  return undefined;
}
