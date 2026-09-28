import {
  GatewayError,
  reportedUsage,
  type AIProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type FinishReason,
  type GatewayErrorType,
  type MeasuredUsage,
  type ModelDescriptor,
  type ProviderCallContext,
  type ProviderHealth,
  type ToolCall,
} from '@ai-gateway/core';
import { HttpClient, iterateSseEvents } from '@ai-gateway/provider-sdk';

export interface AnthropicOptions {
  id?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey: string;
  apiVersion?: string;
  models: ModelDescriptor[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_VERSION = '2023-06-01';
/** Anthropic requires max_tokens; OpenAI does not. Used when the caller omits it. */
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Adapter for the Anthropic Messages API.
 *
 * The interesting work is shape translation: Anthropic hoists the system prompt
 * out of the message list, models assistant tool calls as content blocks rather
 * than a sibling field, and streams typed events instead of uniform deltas.
 * All of that is contained here so the rest of the gateway keeps seeing one
 * normalized chat shape.
 */
export class AnthropicProvider implements AIProvider {
  readonly id: string;
  readonly kind = 'anthropic';
  private readonly http: HttpClient;
  private readonly models: ModelDescriptor[];
  private readonly defaultTimeoutMs: number;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id ?? 'anthropic';
    this.models = opts.models;
    this.defaultTimeoutMs = opts.timeoutMs ?? 120_000;
    this.http = new HttpClient({
      providerId: this.id,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': opts.apiVersion ?? DEFAULT_VERSION,
      },
      defaultTimeoutMs: this.defaultTimeoutMs,
      fetchImpl: opts.fetchImpl,
    });
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse> {
    const { body } = await this.http.requestJson<{
      id?: string;
      content?: AnthropicContentBlock[];
      stop_reason?: string;
      usage?: AnthropicUsage;
    }>({
      path: '/messages',
      body: this.toWire(request, ctx, false),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyAnthropicError,
    });

    const { text, toolCalls } = collectBlocks(body.content ?? []);
    const message: ChatMessage = {
      role: 'assistant',
      content: toolCalls.length > 0 && !text ? null : text,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
      id: body.id ?? ctx.requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model.id,
      choices: [{ index: 0, message, finish_reason: mapStopReason(body.stop_reason) }],
      usage: body.usage ? toUsage(body.usage) : undefined,
    };
  }

  async *stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk> {
    const response = await this.http.requestStream({
      path: '/messages',
      body: this.toWire(request, ctx, true),
      headers: { accept: 'text/event-stream' },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      classify: classifyAnthropicError,
    });

    const messageId = ctx.requestId;
    const created = Math.floor(Date.now() / 1000);
    let usage: MeasuredUsage | undefined;
    let sentRole = false;
    /** Maps Anthropic's content-block index onto an OpenAI tool_call index. */
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;

    const frame = (
      delta: ChatChunk['choices'][number]['delta'],
      finish: FinishReason = null,
      chunkUsage?: MeasuredUsage,
    ): ChatChunk => ({
      id: messageId,
      object: 'chat.completion.chunk',
      created,
      model: ctx.model.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(chunkUsage ? { usage: chunkUsage } : {}),
    });

    for await (const event of iterateSseEvents(response, ctx.signal)) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = (payload['type'] ?? event.event) as string;

      if (type === 'error') {
        const err = payload['error'] as { type?: string; message?: string } | undefined;
        throw new GatewayError(
          err?.type === 'overloaded_error' ? 'provider_overloaded' : 'provider_error',
          'Anthropic reported an error mid-stream.',
          { provider: this.id, model: ctx.model.id, providerCode: err?.type, cause: err },
        );
      }

      if (type === 'message_start') {
        const msg = payload['message'] as { usage?: AnthropicUsage } | undefined;
        if (msg?.usage) usage = toUsage(msg.usage);
        if (!sentRole) {
          sentRole = true;
          yield frame({ role: 'assistant', content: '' });
        }
        continue;
      }

      if (type === 'content_block_start') {
        const block = payload['content_block'] as AnthropicContentBlock | undefined;
        const blockIndex = Number(payload['index'] ?? 0);
        if (block?.type === 'tool_use') {
          const toolIndex = nextToolIndex++;
          toolIndexByBlock.set(blockIndex, toolIndex);
          yield frame({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id ?? `call_${toolIndex}`,
                type: 'function',
                function: { name: block.name ?? '', arguments: '' },
              },
            ],
          });
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const delta = payload['delta'] as { type?: string; text?: string; partial_json?: string } | undefined;
        const blockIndex = Number(payload['index'] ?? 0);
        if (delta?.type === 'text_delta' && delta.text) {
          yield frame({ content: delta.text });
        } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const toolIndex = toolIndexByBlock.get(blockIndex) ?? 0;
          yield frame({
            tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }],
          });
        }
        continue;
      }

      if (type === 'message_delta') {
        const delta = payload['delta'] as { stop_reason?: string } | undefined;
        const deltaUsage = payload['usage'] as AnthropicUsage | undefined;
        if (deltaUsage) {
          // message_delta carries the final output count; input came in message_start.
          usage = toUsage({ ...(deltaUsage ?? {}), input_tokens: usage?.input ?? deltaUsage.input_tokens });
        }
        yield frame({}, mapStopReason(delta?.stop_reason), usage);
        continue;
      }

      if (type === 'message_stop') return;
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      // Anthropic has no unauthenticated liveness endpoint; a 1-token message
      // is the cheapest honest probe. The model list is read from config.
      const probeModel = this.models[0];
      if (!probeModel) {
        return { providerId: this.id, state: 'unknown', checkedAt: Date.now(), message: 'No models configured.' };
      }
      await this.http.requestJson({
        path: '/messages',
        body: {
          model: probeModel.providerModelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        signal,
        timeoutMs: 10_000,
      });
      return { providerId: this.id, state: 'healthy', latencyMs: Date.now() - startedAt, checkedAt: Date.now() };
    } catch (err) {
      const gwErr = GatewayError.from(err);
      const state =
        gwErr.type === 'authentication_error' || gwErr.type === 'permission_denied' ? 'degraded' : 'unavailable';
      return {
        providerId: this.id,
        state,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
        message: gwErr.message,
      };
    }
  }

  private toWire(request: ChatRequest, ctx: ProviderCallContext, stream: boolean): Record<string, unknown> {
    const { system, messages } = splitSystem(request.messages);
    const wire: Record<string, unknown> = {
      model: ctx.model.providerModelId,
      messages,
      max_tokens:
        request.max_completion_tokens ??
        request.max_tokens ??
        Math.min(ctx.model.maxOutputTokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
      stream,
    };
    if (system) wire['system'] = system;
    if (request.temperature !== undefined) wire['temperature'] = request.temperature;
    if (request.top_p !== undefined) wire['top_p'] = request.top_p;
    if (request.stop !== undefined) {
      wire['stop_sequences'] = Array.isArray(request.stop) ? request.stop : [request.stop];
    }
    if (request.tools?.length) {
      wire['tools'] = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    }
    if (request.tool_choice) wire['tool_choice'] = mapToolChoice(request.tool_choice);
    return wire;
  }
}

/** Anthropic takes the system prompt as a top-level field, not a message. */
function splitSystem(messages: ChatMessage[]): { system?: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const out: unknown[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(flattenText(message.content));
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: flattenText(message.content),
          },
        ],
      });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      const text = flattenText(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: safeJson(call.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role, content: toAnthropicContent(message.content) });
  }

  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages: out };
}

function toAnthropicContent(content: ChatMessage['content']): unknown {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((part: ContentPart) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const url = part.image_url.url;
    const dataUrl = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (dataUrl) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] },
      };
    }
    return { type: 'image', source: { type: 'url', url } };
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

function collectBlocks(blocks: AnthropicContentBlock[]): { text: string; toolCalls: ToolCall[] } {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return { text, toolCalls };
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

function mapToolChoice(choice: NonNullable<ChatRequest['tool_choice']>): unknown {
  if (choice === 'none') return { type: 'none' };
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.function.name };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toUsage(usage: AnthropicUsage): MeasuredUsage {
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  const measured = reportedUsage({ input, output, total: input + output });
  if (usage.cache_read_input_tokens) measured.cachedInput = usage.cache_read_input_tokens;
  return measured;
}

export function classifyAnthropicError(status: number, body: unknown): GatewayErrorType | undefined {
  const err = (body as { error?: { type?: string; message?: string } } | undefined)?.error;
  switch (err?.type) {
    case 'overloaded_error':
      return 'provider_overloaded';
    case 'rate_limit_error':
      return 'provider_rate_limit';
    case 'authentication_error':
      return 'authentication_error';
    case 'permission_error':
      return 'permission_denied';
    case 'not_found_error':
      return 'model_not_found';
    case 'request_too_large':
      return 'payload_too_large';
    case 'api_error':
      return 'provider_error';
    default:
      break;
  }
  const message = (err?.message ?? '').toLowerCase();
  if (message.includes('prompt is too long') || message.includes('context window')) {
    return 'context_length_exceeded';
  }
  if (status === 529) return 'provider_overloaded';
  return undefined;
}
