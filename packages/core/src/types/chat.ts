export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  /** Either a plain string or multimodal parts. `null` for assistant tool-call turns. */
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ToolChoice =
  'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

/** Gateway-specific request extensions, namespaced so they never collide with OpenAI fields. */
export interface GatewayExtensions {
  /** Routing strategy override for this one request. */
  strategy?: string;
  /** Explicit ordered candidate list, e.g. `["openai/gpt-x", "anthropic/model-y"]`. */
  models?: string[];
  /** Named routing policy to apply instead of the project default. */
  policy?: string;
  /** Cache directives. `no-store` disables both read and write for this request. */
  cache?: 'auto' | 'no-store' | 'exact-only' | 'semantic';
  /** Override the policy's semantic similarity floor, 0..1. */
  cacheSimilarityThreshold?: number;
  /** Disable automatic fallback for this request. */
  fallback?: boolean;
  /** Per-request timeout in milliseconds, clamped by policy. */
  timeoutMs?: number;
  /** Marks a playground/test call so it never lands in production analytics. */
  test?: boolean;
  /** Free-form tags recorded on the request row for analytics slicing. */
  tags?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /** OpenAI's newer name for `max_tokens`; the gateway accepts either. */
  max_completion_tokens?: number;
  stop?: string | string[];
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  user?: string;
  metadata?: Record<string, string>;
  /** Namespaced gateway controls. */
  gateway?: GatewayExtensions;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /** Tokens served from the provider's own prompt cache, when reported. */
  cachedInput?: number;
  reasoning?: number;
}

/**
 * Where a usage number came from. Estimated counts are approximations the
 * gateway derived itself and are labelled as such everywhere they surface.
 */
export type UsageSource = 'provider_reported' | 'estimated';

export interface MeasuredUsage extends TokenUsage {
  source: UsageSource;
}

export type FinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'cancelled' | null;

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: FinishReason;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: MeasuredUsage;
  /** Populated by the gateway, not by providers. */
  gateway?: RoutingReceipt;
}

export interface ChatChunkDelta {
  role?: ChatRole;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatChunkDelta;
    finish_reason: FinishReason;
  }>;
  /** Some providers emit usage on the final chunk. */
  usage?: MeasuredUsage;
}

/**
 * The gateway's answer to "why did my request go where it went?".
 * Attached to every non-streaming response and emitted as a terminal SSE event
 * on streaming responses.
 */
export interface RoutingReceipt {
  requestId: string;
  provider: string;
  model: string;
  strategy: string;
  /** Human-readable reasons the router picked this route. */
  reasons: string[];
  cache: 'miss' | 'exact_hit' | 'semantic_hit' | 'disabled' | 'bypass';
  cacheSimilarity?: number;
  attempts: number;
  fallbackUsed: boolean;
  /** Candidates considered but not chosen, with the reason each was skipped. */
  rejected?: Array<{ target: string; reason: string }>;
  latencyMs: number;
  usageSource?: UsageSource;
  estimatedCost?: {
    amount: number;
    currency: string;
    pricingVersion: string;
  };
}
