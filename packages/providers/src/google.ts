import {
  GatewayError,
  reportedUsage,
  type AIProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type FinishReason,
  type GatewayErrorType,
  type MeasuredUsage,
  type ModelDescriptor,
  type ProviderCallContext,
  type ProviderHealth,
  type ToolCall,
} from '@ai-gateway/core';
import { HttpClient, iterateSseJson } from '@ai-gateway/provider-sdk';

export interface GoogleOptions {
  id?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey: string;
  models: ModelDescriptor[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Adapter for Google's Generative Language API.
 *
 * Gemini differs from the OpenAI shape in three ways that matter here: the
 * model id lives in the URL path rather than the body, assistant turns are
 * called `model`, and the system prompt is a separate `systemInstruction`.
 */
export class GoogleProvider implements AIProvider {
  readonly id: string;
  readonly kind = 'google';
  private readonly http: HttpClient;
  private readonly models: ModelDescriptor[];
  private readonly apiKey: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: GoogleOptions) {
    this.id = opts.id ?? 'google';
    this.models = opts.models;
    this.apiKey = opts.apiKey;
    this.defaultTimeoutMs = opts.timeoutMs ?? 120_000;
    this.http = new HttpClient({
      providerId: this.id,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      // Header auth rather than `?key=` so the credential never lands in a
      // proxy access log or an error URL.
      headers: { 'x-goog-api-key': opts.apiKey },
      defaultTimeoutMs: this.defaultTimeoutMs,
      fetchImpl: opts.fetchImpl,
    });
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse> {
    const { body } = await this.http.requestJson<{
      candidates?: GeminiCandidate[];
      usageMetadata?: GeminiUsage;
    }>({
      path: `/models/${encodeURIComponent(ctx.model.providerModelId)}:generateContent`,
      body: this.toWire(request),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyGoogleError,
    });

    const candidate = body.candidates?.[0];
    if (!candidate) {
      throw new GatewayError('provider_error', 'Gemini returned no candidates.', {
        provider: this.id,
        model: ctx.model.id,
      });
    }

    const { text, toolCalls } = collectParts(candidate.content?.parts ?? []);
    const message: ChatMessage = {
      role: 'assistant',
      content: toolCalls.length > 0 && !text ? null : text,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
      id: ctx.requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model.id,
      choices: [{ index: 0, message, finish_reason: mapFinishReason(candidate.finishReason) }],
      usage: body.usageMetadata ? toUsage(body.usageMetadata) : undefined,
    };
  }

  async *stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk> {
    const response = await this.http.requestStream({
      path: `/models/${encodeURIComponent(ctx.model.providerModelId)}:streamGenerateContent?alt=sse`,
      body: this.toWire(request),
      headers: { accept: 'text/event-stream' },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyGoogleError,
    });

    const created = Math.floor(Date.now() / 1000);
    let sentRole = false;
    let toolIndex = 0;

    const frame = (
      delta: ChatChunk['choices'][number]['delta'],
      finish: FinishReason = null,
      usage?: MeasuredUsage,
    ): ChatChunk => ({
      id: ctx.requestId,
      object: 'chat.completion.chunk',
      created,
      model: ctx.model.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });

    for await (const payload of iterateSseJson<{
      candidates?: GeminiCandidate[];
      usageMetadata?: GeminiUsage;
      error?: { message?: string; status?: string };
    }>(response, ctx.signal)) {
      if (payload.error) {
        throw new GatewayError('provider_error', 'Gemini reported an error mid-stream.', {
          provider: this.id,
          model: ctx.model.id,
          providerCode: payload.error.status,
          cause: payload.error,
        });
      }

      if (!sentRole) {
        sentRole = true;
        yield frame({ role: 'assistant', content: '' });
      }

      const candidate = payload.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text) yield frame({ content: part.text });
        if (part.functionCall) {
          yield frame({
            tool_calls: [
              {
                index: toolIndex,
                id: `call_${ctx.requestId}_${toolIndex}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                },
              },
            ],
          });
          toolIndex++;
        }
      }

      if (candidate?.finishReason) {
        yield frame(
          {},
          mapFinishReason(candidate.finishReason),
          payload.usageMetadata ? toUsage(payload.usageMetadata) : undefined,
        );
      }
    }
  }

  async embed(request: EmbeddingsRequest, ctx: ProviderCallContext): Promise<EmbeddingsResponse> {
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const { body } = await this.http.requestJson<{ embeddings?: Array<{ values: number[] }> }>({
      path: `/models/${encodeURIComponent(ctx.model.providerModelId)}:batchEmbedContents`,
      body: {
        requests: inputs.map((text) => ({
          model: `models/${ctx.model.providerModelId}`,
          content: { parts: [{ text }] },
          ...(request.dimensions ? { outputDimensionality: request.dimensions } : {}),
        })),
      },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyGoogleError,
    });

    return {
      object: 'list',
      model: ctx.model.id,
      data: (body.embeddings ?? []).map((e, index) => ({
        object: 'embedding' as const,
        index,
        embedding: e.values,
      })),
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await this.http.requestJson({ path: '/models', method: 'GET', signal, timeoutMs: 10_000 });
      return {
        providerId: this.id,
        state: 'healthy',
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
      };
    } catch (err) {
      const gwErr = GatewayError.from(err);
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

  private toWire(request: ChatRequest): Record<string, unknown> {
    const systemParts: string[] = [];
    const contents: unknown[] = [];

    for (const message of request.messages) {
      if (message.role === 'system') {
        systemParts.push(flattenText(message.content));
        continue;
      }
      if (message.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: message.name ?? message.tool_call_id ?? 'tool',
                response: { result: flattenText(message.content) },
              },
            },
          ],
        });
        continue;
      }
      const role = message.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiPart[] = [];
      const text = toParts(message.content);
      parts.push(...text);
      for (const call of message.tool_calls ?? []) {
        parts.push({
          functionCall: { name: call.function.name, args: safeJson(call.function.arguments) },
        });
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role, parts });
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.top_p !== undefined) generationConfig['topP'] = request.top_p;
    const maxTokens = request.max_completion_tokens ?? request.max_tokens;
    if (maxTokens !== undefined) generationConfig['maxOutputTokens'] = maxTokens;
    if (request.stop !== undefined) {
      generationConfig['stopSequences'] = Array.isArray(request.stop)
        ? request.stop
        : [request.stop];
    }
    if (request.response_format?.type === 'json_object') {
      generationConfig['responseMimeType'] = 'application/json';
    }
    if (request.response_format?.type === 'json_schema' && request.response_format.json_schema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = request.response_format.json_schema.schema;
    }

    const wire: Record<string, unknown> = { contents };
    if (systemParts.length)
      wire['systemInstruction'] = { parts: [{ text: systemParts.join('\n\n') }] };
    if (Object.keys(generationConfig).length) wire['generationConfig'] = generationConfig;
    if (request.tools?.length) {
      wire['tools'] = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters ?? { type: 'object', properties: {} },
          })),
        },
      ];
    }
    return wire;
  }
}

function toParts(content: ChatMessage['content']): GeminiPart[] {
  if (content === null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return content.map((part: ContentPart): GeminiPart => {
    if (part.type === 'text') return { text: part.text };
    const url = part.image_url.url;
    const dataUrl = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (dataUrl?.[1] && dataUrl[2]) {
      return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
    }
    return { fileData: { fileUri: url } };
  });
}

function flattenText(content: ChatMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function collectParts(parts: GeminiPart[]): { text: string; toolCalls: ToolCall[] } {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  return { text, toolCalls };
}

function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    case 'RECITATION':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toUsage(usage: GeminiUsage): MeasuredUsage {
  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  const measured = reportedUsage({ input, output, total: usage.totalTokenCount ?? input + output });
  if (usage.cachedContentTokenCount) measured.cachedInput = usage.cachedContentTokenCount;
  return measured;
}

export function classifyGoogleError(status: number, body: unknown): GatewayErrorType | undefined {
  const err = (body as { error?: { status?: string; message?: string } } | undefined)?.error;
  switch (err?.status) {
    case 'RESOURCE_EXHAUSTED':
      return 'provider_rate_limit';
    case 'UNAVAILABLE':
      return 'provider_unavailable';
    case 'DEADLINE_EXCEEDED':
      return 'provider_timeout';
    case 'PERMISSION_DENIED':
      return 'permission_denied';
    case 'UNAUTHENTICATED':
      return 'authentication_error';
    case 'NOT_FOUND':
      return 'model_not_found';
    default:
      break;
  }
  const message = (err?.message ?? '').toLowerCase();
  if (
    message.includes('exceeds the maximum number of tokens') ||
    message.includes('input token count')
  ) {
    return 'context_length_exceeded';
  }
  if (message.includes('safety') || message.includes('blocked')) return 'content_filter';
  if (status === 429) return 'provider_rate_limit';
  return undefined;
}
