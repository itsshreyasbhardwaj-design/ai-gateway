import type { ChatChunk, ChatRequest, ChatResponse } from './chat.js';
import type { EmbeddingsRequest, EmbeddingsResponse } from './embeddings.js';
import type { ModelDescriptor } from './model.js';

export type ProviderHealthState = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

export interface ProviderHealth {
  providerId: string;
  state: ProviderHealthState;
  /** Round-trip of the health probe itself, in ms. */
  latencyMs?: number;
  checkedAt: number;
  message?: string;
}

export interface ProviderCallContext {
  requestId: string;
  attempt: number;
  /** Cancels the upstream call when the client hangs up or the deadline passes. */
  signal: AbortSignal;
  timeoutMs: number;
  /** The concrete model to call, already resolved from the gateway model ref. */
  model: ModelDescriptor;
}

/**
 * Every provider adapter implements exactly this. The gateway core never
 * imports a vendor SDK and no route handler ever branches on provider id.
 */
export interface AIProvider {
  readonly id: string;
  readonly kind: string;

  /** Models this provider can serve right now. */
  listModels(): Promise<ModelDescriptor[]>;

  chat(request: ChatRequest, ctx: ProviderCallContext): Promise<ChatResponse>;

  stream(request: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatChunk>;

  /** Optional: providers without an embeddings endpoint simply omit this. */
  embed?(request: EmbeddingsRequest, ctx: ProviderCallContext): Promise<EmbeddingsResponse>;

  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
}

export interface ProviderCredentialRef {
  /** Name of the env var or secret entry holding the key. Never the key itself. */
  ref: string;
}

export interface ProviderConfig {
  id: string;
  kind: string;
  displayName: string;
  baseUrl?: string;
  /** Indirection only - raw secrets never live in provider config rows. */
  credential?: ProviderCredentialRef;
  timeoutMs?: number;
  enabled: boolean;
  /** Extra headers required by some OpenAI-compatible gateways. */
  headers?: Record<string, string>;
  /** Models this provider exposes, for providers without a discovery endpoint. */
  models?: ModelDescriptor[];
  /** Weight used by the weighted routing strategy. */
  weight?: number;
  /** Lower number wins under the priority strategy. */
  priority?: number;
}
