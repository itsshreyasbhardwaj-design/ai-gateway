export type ModelCapability =
  | 'chat'
  | 'streaming'
  | 'tools'
  | 'vision'
  | 'structured-output'
  | 'json-mode'
  | 'embeddings'
  | 'reasoning';

export type ModelStatus = 'available' | 'degraded' | 'deprecated' | 'disabled';

export interface ModelPricing {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  /** Discounted rate for provider-cached prompt tokens, when the provider offers one. */
  cachedInputPerMillionTokens?: number;
  currency: string;
}

/**
 * Pricing is *configuration*, not a fact the gateway knows. Every price carries
 * the version it came from so historical cost rows stay reproducible after an
 * administrator updates the table.
 */
export interface PricingRecord extends ModelPricing {
  pricingVersion: string;
  /** Where these numbers came from, e.g. "seed:2026-09" or "admin:alice@acme". */
  source: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface ModelDescriptor {
  /** Stable gateway-wide identifier: `<providerId>/<providerModelId>`. */
  id: string;
  providerId: string;
  /** Model ID as the provider's own API expects it. */
  providerModelId: string;
  displayName: string;
  /** Total context window in tokens, per the provider's documentation. */
  contextWindow: number;
  maxOutputTokens?: number;
  capabilities: ModelCapability[];
  status: ModelStatus;
  /** Pricing is looked up separately through the pricing book; this is a cached view. */
  pricing?: PricingRecord;
  /** Family grouping used for semantic-cache scoping, e.g. "gpt", "claude". */
  family?: string;
  description?: string;
  deprecatedAt?: string | null;
}

export function modelSupports(model: ModelDescriptor, cap: ModelCapability): boolean {
  return model.capabilities.includes(cap);
}

export function parseModelRef(ref: string): { providerId: string; providerModelId: string } | null {
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { providerId: ref.slice(0, idx), providerModelId: ref.slice(idx + 1) };
}

/** Virtual model names the router resolves rather than sending upstream verbatim. */
export const VIRTUAL_MODELS = {
  auto: 'gateway/auto',
  cheapest: 'gateway/cheapest',
  fastest: 'gateway/fastest',
  mostReliable: 'gateway/most-reliable',
} as const;

export function isVirtualModel(model: string): boolean {
  return model.startsWith('gateway/');
}
