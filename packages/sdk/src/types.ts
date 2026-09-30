/**
 * Wire types for the AI Gateway HTTP API.
 *
 * Duplicated here rather than imported from `@ai-gateway/core` on purpose: the
 * SDK is published standalone with zero runtime dependencies, and an
 * application should not have to install the gateway's internals to call it.
 */

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

export type RoutingStrategy =
  | 'explicit'
  | 'lowest_cost'
  | 'lowest_latency'
  | 'highest_reliability'
  | 'weighted'
  | 'priority'
  | 'round_robin'
  | 'fallback_chain';

/** Gateway-specific controls, namespaced so they never collide with OpenAI fields. */
export interface GatewayExtensions {
  strategy?: RoutingStrategy;
  /** Explicit ordered candidates, e.g. `["openai/gpt-4o-mini", "anthropic/claude-haiku-4"]`. */
  models?: string[];
  policy?: string;
  cache?: 'auto' | 'no-store' | 'exact-only' | 'semantic';
  cacheSimilarityThreshold?: number;
  fallback?: boolean;
  timeoutMs?: number;
  /** Marks the call as test traffic, excluded from production analytics. */
  test?: boolean;
  tags?: string[];
}

export interface ChatCompletionCreateParams {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  tools?: ToolDefinition[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  };
  user?: string;
  metadata?: Record<string, string>;
  gateway?: GatewayExtensions;
}

export type UsageSource = 'provider_reported' | 'estimated';

export interface Usage {
  input: number;
  output: number;
  total: number;
  cachedInput?: number;
  reasoning?: number;
  /**
   * `estimated` means the gateway approximated these counts because the
   * provider did not report them. Treat estimated numbers as approximate.
   */
  source: UsageSource;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'cancelled' | null;

/** The gateway's answer to "why did my request go where it went?". */
export interface RoutingReceipt {
  requestId: string;
  provider: string;
  model: string;
  strategy: string;
  reasons: string[];
  cache: 'miss' | 'exact_hit' | 'semantic_hit' | 'disabled' | 'bypass';
  cacheSimilarity?: number;
  attempts: number;
  fallbackUsed: boolean;
  rejected?: Array<{ target: string; reason: string }>;
  latencyMs: number;
  usageSource?: UsageSource;
  /** Computed from the gateway's configured price table, not a provider invoice. */
  estimatedCost?: { amount: number; currency: string; pricingVersion: string };
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: ChatMessage; finish_reason: FinishReason }>;
  usage?: Usage;
  gateway?: RoutingReceipt;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: ChatRole;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: FinishReason;
  }>;
  usage?: Usage;
}

export interface EmbeddingsCreateParams {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
  gateway?: { test?: boolean; tags?: string[] };
}

export interface EmbeddingsResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage?: Usage;
  gateway?: { requestId: string; provider: string; model: string; latencyMs: number };
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  gateway: {
    displayName: string;
    provider: string;
    providerModelId: string;
    contextWindow: number;
    maxOutputTokens?: number;
    capabilities: string[];
    status: string;
    family?: string;
    pricing: {
      inputPerMillionTokens: number;
      outputPerMillionTokens: number;
      cachedInputPerMillionTokens?: number;
      currency: string;
      version: string;
      source: string;
      asOf: string;
    } | null;
  };
}

export interface ModelList {
  object: 'list';
  data: ModelInfo[];
  gateway: { pricingVersion: string; pricingAgeDays: number; virtualModels: string[] };
}

export type GatewayErrorType =
  | 'invalid_request'
  | 'authentication_error'
  | 'permission_denied'
  | 'model_not_allowed'
  | 'model_not_found'
  | 'policy_violation'
  | 'budget_exceeded'
  | 'rate_limit'
  | 'context_length_exceeded'
  | 'content_filter'
  | 'capability_unsupported'
  | 'payload_too_large'
  | 'provider_rate_limit'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_overloaded'
  | 'provider_error'
  | 'circuit_open'
  | 'no_route_available'
  | 'fallback_exhausted'
  | 'client_disconnected'
  | 'internal_error';

export interface ErrorBody {
  error: {
    type: GatewayErrorType;
    message: string;
    requestId?: string;
    retryable: boolean;
    provider?: string;
    model?: string;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  };
}
