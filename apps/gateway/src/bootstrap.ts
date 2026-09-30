import { DEFAULT_PRIVACY, newId, type Organization, type Project, type ProviderConfig } from '@ai-gateway/core';
import { MemoryKV, RedisKV, ResilientKV, SemanticCache, type KeyValueStore } from '@ai-gateway/cache';
import { describeConfig, loadGatewayConfig, type GatewayConfig } from '@ai-gateway/config';
import { createStore, type Store } from '@ai-gateway/database';
import { createLogger, registerDefaultMetrics, MetricsRegistry, type Logger } from '@ai-gateway/observability';
import { createSeedPricingBook, isUnverified, type PricingBook } from '@ai-gateway/pricing';
import { ProviderRegistry, ChainCredentialResolver, EnvCredentialResolver, MapCredentialResolver } from '@ai-gateway/provider-sdk';
import { buildProvider, MockProvider, type ProviderKind } from '@ai-gateway/providers';
import { generateApiKey, keyIndex, hashApiKey, SecretBox } from '@ai-gateway/security';
import { buildContext, type GatewayContext } from './context.js';
import { WebhookDispatcher } from './webhooks.js';

export interface BootstrapOverrides {
  config?: GatewayConfig;
  store?: Store;
  kv?: KeyValueStore;
  logger?: Logger;
  pricing?: PricingBook;
  fetchImpl?: typeof fetch;
  /** Skip provider construction and register these instead. Used by tests. */
  providers?: ProviderRegistry;
}

export interface BootstrapResult {
  ctx: GatewayContext;
  banner: string[];
  demo?: DemoSeed;
}

export interface DemoSeed {
  organizationId: string;
  projectId: string;
  apiKey: string;
  note: string;
}

/**
 * Assemble a running gateway from configuration.
 *
 * The ordering matters: storage before providers (provider credentials may be
 * stored encrypted), providers before the semantic cache (which needs an
 * embedding model to exist), and the banner last so it reports what actually
 * came up rather than what was requested.
 */
export async function bootstrap(overrides: BootstrapOverrides = {}): Promise<BootstrapResult> {
  const config = overrides.config ?? loadGatewayConfig();
  const logger = overrides.logger ?? createLogger({ level: config.logLevel, pretty: config.logPretty });

  const store = overrides.store ?? (await createStore(config.databaseUrl));
  await store.migrate();

  const kv = overrides.kv ?? (await createKv(config, logger));
  const pricing = overrides.pricing ?? createSeedPricingBook();
  const secrets = new SecretBox(config.encryptionKey);

  const metrics = new MetricsRegistry();
  registerDefaultMetrics(metrics);

  const webhooks = new WebhookDispatcher({ store, secrets, logger, fetchImpl: overrides.fetchImpl });

  const { registry, mockProvider, notes } = overrides.providers
    ? { registry: overrides.providers, mockProvider: undefined, notes: [] as string[] }
    : await buildProviderRegistry(config, store, secrets, logger, overrides.fetchImpl);

  const semanticCache = createSemanticCache(config, registry, logger);

  const ctx = buildContext({
    config,
    logger,
    store,
    kv,
    providers: registry,
    pricing,
    webhooks,
    semanticCache,
    mockProvider,
    metrics,
  });

  const banner = [...describeConfig(config), ...notes];
  if (isUnverified(pricing.version)) {
    banner.push(
      `warning: pricing table "${pricing.version}" is the shipped placeholder set and is NOT verified against provider price lists. Cost figures are illustrative until you publish a verified snapshot.`,
    );
  }
  if (semanticCache) banner.push('semantic cache: enabled');

  const demo = config.seedDemoData ? await seedDemoData(ctx) : await ensureBootstrapTenant(ctx);
  if (demo) banner.push(demo.note);

  return { ctx, banner, demo };
}

async function createKv(config: GatewayConfig, logger: Logger): Promise<KeyValueStore> {
  if (!config.redisUrl) return new MemoryKV();
  try {
    const redis = await RedisKV.connect(config.redisUrl);
    // Caching and counters degrade rather than break when Redis blips; budget
    // enforcement reads through `raw` so it never fails open.
    return new ResilientKV(redis, (op, err) =>
      logger.warn('redis operation failed; degrading', { operation: op, error: (err as Error)?.message }),
    );
  } catch (err) {
    logger.error('could not connect to Redis; falling back to in-process counters', {
      error: (err as Error).message,
    });
    return new MemoryKV();
  }
}

async function buildProviderRegistry(
  config: GatewayConfig,
  store: Store,
  secrets: SecretBox,
  logger: Logger,
  fetchImpl?: typeof fetch,
): Promise<{ registry: ProviderRegistry; mockProvider?: MockProvider; notes: string[] }> {
  const registry = new ProviderRegistry();
  const notes: string[] = [];
  let mockProvider: MockProvider | undefined;

  // Env vars first, then any credential an administrator stored encrypted.
  const stored = new MapCredentialResolver();
  const credentials = new ChainCredentialResolver([new EnvCredentialResolver(), stored]);

  const urlGuard = { allowedHosts: config.providerAllowedHosts, allowInsecureHttp: false };

  for (const providerConfig of config.providers) {
    try {
      const built = await buildProvider({ config: providerConfig, credentials, urlGuard, fetchImpl });
      registry.register(built.provider, built.models);
      if (providerConfig.kind === 'mock') mockProvider = built.provider as MockProvider;
      logger.info('provider registered', { provider: providerConfig.id, models: built.models.length });
    } catch (err) {
      // One misconfigured provider must not stop the gateway: the rest still
      // serve, and the failure is reported rather than swallowed.
      const message = (err as Error).message;
      notes.push(`warning: provider "${providerConfig.id}" was not registered: ${message}`);
      logger.error('provider registration failed', { provider: providerConfig.id, error: message });
    }
  }

  if (registry.size === 0) {
    notes.push(
      'warning: no providers registered. Set a provider API key (or ENABLE_MOCK_PROVIDER=true) before sending inference requests.',
    );
  }

  return { registry, mockProvider, notes };
}

/**
 * Wire the semantic cache only if an embedding model is actually available.
 *
 * Silently degrading to "semantic caching enabled but never hits" would be
 * worse than leaving it off, so this returns undefined and says why.
 */
function createSemanticCache(
  config: GatewayConfig,
  registry: ProviderRegistry,
  logger: Logger,
): SemanticCache | undefined {
  const requested = config.semanticCacheEmbeddingModel;
  if (!requested) return undefined;

  const model = registry.getModel(requested);
  if (!model || !model.capabilities.includes('embeddings')) {
    logger.warn('semantic cache disabled', {
      model: requested,
      reason: model ? 'model does not support embeddings' : 'model is not registered',
    });
    return undefined;
  }

  const provider = registry.getProvider(model.providerId);
  if (!provider?.embed) {
    logger.warn('semantic cache disabled', { model: requested, reason: 'provider has no embeddings endpoint' });
    return undefined;
  }

  return new SemanticCache(new MemoryKV(), async (text, signal) => {
    const response = await provider.embed!(
      { model: model.id, input: text },
      {
        requestId: 'cache-embed',
        attempt: 1,
        signal: signal ?? new AbortController().signal,
        timeoutMs: 10_000,
        model,
      },
    );
    return response.data[0]?.embedding ?? [];
  });
}

/**
 * Create a first organization, project and API key if the store is empty.
 *
 * A gateway you cannot authenticate against is not usable, and asking a new
 * operator to hand-write database rows before their first request is a bad
 * first five minutes. The key is printed once, to the log, and never stored.
 */
async function ensureBootstrapTenant(ctx: GatewayContext): Promise<DemoSeed | undefined> {
  const existing = await ctx.store.listOrganizations();
  if (existing.length > 0) return undefined;
  return createTenant(ctx, {
    orgName: 'Default',
    orgSlug: 'default',
    projectName: 'Production',
    projectSlug: 'production',
    note: 'A default organization, project and API key were created because the store was empty.',
  });
}

/**
 * Seed a labelled demo tenant.
 *
 * Demo request history is generated by `scripts/seed-demo.ts` and every row it
 * writes is tagged `demo` and flagged `isTest`, so it is excluded from
 * production analytics and visibly labelled in the dashboard.
 */
async function seedDemoData(ctx: GatewayContext): Promise<DemoSeed | undefined> {
  const existing = await ctx.store.getOrganizationBySlug('demo');
  if (existing) {
    const projects = await ctx.store.listProjects(existing.id);
    const project = projects[0];
    if (project) {
      return {
        organizationId: existing.id,
        projectId: project.id,
        apiKey: '(existing demo key retained; it is only shown at creation time)',
        note: 'Demo organization already present; no new API key was minted.',
      };
    }
  }
  return createTenant(ctx, {
    orgName: 'Demo Organization',
    orgSlug: 'demo',
    projectName: 'Demo Project',
    projectSlug: 'demo',
    note: 'Demo data seeded. Demo traffic is flagged as test data and excluded from production analytics.',
  });
}

async function createTenant(
  ctx: GatewayContext,
  opts: { orgName: string; orgSlug: string; projectName: string; projectSlug: string; note: string },
): Promise<DemoSeed> {
  const now = new Date().toISOString();

  const organization: Organization = {
    id: newId('org'),
    name: opts.orgName,
    slug: opts.orgSlug,
    createdAt: now,
    privacy: DEFAULT_PRIVACY,
    currency: 'USD',
    allowedModels: null,
    deniedModels: [],
  };
  await ctx.store.createOrganization(organization);

  const project: Project = {
    id: newId('proj'),
    organizationId: organization.id,
    name: opts.projectName,
    slug: opts.projectSlug,
    createdAt: now,
  };
  await ctx.store.createProject(project);

  // A fixed key is only honoured outside production, so docs and the e2e suite
  // can quote one without ever creating a predictable production credential.
  const fixed = ctx.config.demoApiKey;
  const useFixed = fixed && ctx.config.nodeEnv !== 'production';
  const plaintext = useFixed ? fixed : (await generateApiKey(ctx.config.nodeEnv === 'production' ? 'live' : 'test')).plaintext;
  const hash = await hashApiKey(plaintext);

  await ctx.store.createApiKey({
    id: newId('key'),
    organizationId: organization.id,
    projectId: project.id,
    name: 'Bootstrap key',
    prefix: plaintext.slice(0, 16),
    hash,
    lookupIndex: keyIndex(plaintext, ctx.config.apiKeyPepper),
    scopes: ['models.read', 'inference.create', 'usage.read', 'logs.read', 'admin'],
    createdAt: now,
    createdBy: 'system:bootstrap',
  });

  for (const model of ctx.providers.listModels()) {
    await ctx.store.upsertModel(organization.id, model).catch(() => undefined);
  }
  for (const providerConfig of ctx.config.providers) {
    await ctx.store.upsertProvider(organization.id, sanitizeProvider(providerConfig)).catch(() => undefined);
  }

  return { organizationId: organization.id, projectId: project.id, apiKey: plaintext, note: opts.note };
}

/** Provider rows hold a credential *reference*, never a value. */
function sanitizeProvider(config: ProviderConfig): ProviderConfig {
  const { models: _models, ...rest } = config;
  return { ...rest, kind: rest.kind as ProviderKind };
}
