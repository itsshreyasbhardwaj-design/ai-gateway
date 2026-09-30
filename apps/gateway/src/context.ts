import type { Clock } from '@ai-gateway/core';
import { systemClock } from '@ai-gateway/core';
import type { KeyValueStore } from '@ai-gateway/cache';
import { ExactCache, type SemanticCache } from '@ai-gateway/cache';
import type { GatewayConfig } from '@ai-gateway/config';
import type { Store } from '@ai-gateway/database';
import {
  CircuitBreakerRegistry,
  HealthTracker,
  MetricsRegistry,
  type Logger,
} from '@ai-gateway/observability';
import type { PricingBook } from '@ai-gateway/pricing';
import type { ProviderRegistry } from '@ai-gateway/provider-sdk';
import { RateLimiter } from '@ai-gateway/rate-limit';
import { SecretBox } from '@ai-gateway/security';
import { SpendCounters } from '@ai-gateway/usage';
import type { MockProvider } from '@ai-gateway/providers';
import type { WebhookDispatcher } from './webhooks.js';
import { AuthCache } from './auth-cache.js';

/**
 * Everything the request pipeline needs, assembled once at boot.
 *
 * Constructor injection rather than module-level singletons: the e2e suite
 * builds a whole gateway per test file with an in-memory store, a fake clock
 * and a mock provider, which is only possible because nothing here reaches for
 * global state.
 */
export interface GatewayContext {
  config: GatewayConfig;
  logger: Logger;
  store: Store;
  kv: KeyValueStore;
  providers: ProviderRegistry;
  pricing: PricingBook;
  metrics: MetricsRegistry;
  health: HealthTracker;
  circuits: CircuitBreakerRegistry;
  rateLimiter: RateLimiter;
  spend: SpendCounters;
  exactCache: ExactCache;
  semanticCache?: SemanticCache;
  secrets: SecretBox;
  webhooks: WebhookDispatcher;
  /** Short-lived cache of verified API keys; keeps scrypt off the hot path. */
  authCache: AuthCache;
  clock: Clock;
  /** Present only when the synthetic provider is registered, for the failover simulator. */
  mockProvider?: MockProvider;
  /** Monotonic counter backing round-robin and weighted routing. */
  nextRoutingCursor(): number;
  shutdown(): Promise<void>;
}

export interface BuildContextParts {
  config: GatewayConfig;
  logger: Logger;
  store: Store;
  kv: KeyValueStore;
  providers: ProviderRegistry;
  pricing: PricingBook;
  webhooks: WebhookDispatcher;
  semanticCache?: SemanticCache;
  mockProvider?: MockProvider;
  clock?: Clock;
  metrics?: MetricsRegistry;
  health?: HealthTracker;
  circuits?: CircuitBreakerRegistry;
}

export function buildContext(parts: BuildContextParts): GatewayContext {
  const clock = parts.clock ?? systemClock;
  const metrics = parts.metrics ?? new MetricsRegistry();
  const health = parts.health ?? new HealthTracker(undefined, clock);
  const circuits = parts.circuits ?? new CircuitBreakerRegistry(undefined, clock);
  let cursor = 0;

  return {
    config: parts.config,
    logger: parts.logger,
    store: parts.store,
    kv: parts.kv,
    providers: parts.providers,
    pricing: parts.pricing,
    metrics,
    health,
    circuits,
    rateLimiter: new RateLimiter({ kv: parts.kv, clock }),
    spend: new SpendCounters(parts.kv),
    exactCache: new ExactCache(parts.kv),
    semanticCache: parts.semanticCache,
    secrets: new SecretBox(parts.config.encryptionKey),
    webhooks: parts.webhooks,
    authCache: new AuthCache({ clock }),
    clock,
    mockProvider: parts.mockProvider,
    nextRoutingCursor: () => cursor++,
    async shutdown() {
      await parts.kv.close().catch(() => undefined);
      await parts.store.close().catch(() => undefined);
    },
  };
}

/** Key used for health and circuit-breaker bookkeeping. */
export function targetKey(providerId: string, modelId?: string): string {
  return modelId ? `${providerId}::${modelId}` : providerId;
}
