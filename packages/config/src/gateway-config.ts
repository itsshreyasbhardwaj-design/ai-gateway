import { randomBytes } from 'node:crypto';
import type { ProviderConfig } from '@ai-gateway/core';
import {
  availableProviderCredentials,
  mockProviderEnabled,
  parseEnv,
  type EnvIssue,
  type RawEnv,
} from './env.js';

export interface GatewayConfig {
  env: RawEnv;
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logPretty: boolean;
  trustProxy: boolean;
  corsOrigins: string[];
  databaseUrl?: string;
  redisUrl?: string;
  encryptionKey: string;
  apiKeyPepper: string;
  providerAllowedHosts: string[];
  defaultTimeoutMs: number;
  maxRequestBytes: number;
  seedDemoData: boolean;
  demoApiKey?: string;
  semanticCacheEmbeddingModel?: string;
  /** Providers derived from the environment, ready to register. */
  providers: ProviderConfig[];
  warnings: EnvIssue[];
  /** True when a throwaway secret was generated for this process. */
  ephemeralSecrets: string[];
}

export class ConfigError extends Error {
  constructor(readonly issues: EnvIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Build the gateway's runtime configuration.
 *
 * Provider wiring is derived from which credentials are actually present: a
 * fresh clone with no keys still boots, with the mock provider registered, and
 * says so. Nothing here fabricates a configured provider that cannot serve.
 */
export function loadGatewayConfig(source: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = parseEnv(source);
  if (!parsed.ok) throw new ConfigError(parsed.issues);

  const { env } = parsed;
  const ephemeralSecrets: string[] = [];

  let encryptionKey = env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    encryptionKey = randomBytes(32).toString('base64');
    ephemeralSecrets.push('ENCRYPTION_KEY');
  }

  let apiKeyPepper = env.API_KEY_PEPPER;
  if (!apiKeyPepper) {
    apiKeyPepper = randomBytes(32).toString('base64');
    ephemeralSecrets.push('API_KEY_PEPPER');
  }

  return {
    env,
    nodeEnv: env.NODE_ENV,
    port: env.GATEWAY_PORT,
    host: env.GATEWAY_HOST,
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    trustProxy: env.TRUST_PROXY,
    corsOrigins: env.CORS_ORIGINS,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    encryptionKey,
    apiKeyPepper,
    providerAllowedHosts: env.PROVIDER_ALLOWED_HOSTS,
    defaultTimeoutMs: env.DEFAULT_REQUEST_TIMEOUT_MS,
    maxRequestBytes: env.MAX_REQUEST_BYTES,
    seedDemoData: env.SEED_DEMO_DATA,
    demoApiKey: env.DEMO_API_KEY,
    semanticCacheEmbeddingModel: env.SEMANTIC_CACHE_EMBEDDING_MODEL,
    providers: providersFromEnv(env),
    warnings: parsed.warnings,
    ephemeralSecrets,
  };
}

/** Derive provider configuration from the credentials that are present. */
export function providersFromEnv(env: RawEnv): ProviderConfig[] {
  const available = new Set(availableProviderCredentials(env));
  const providers: ProviderConfig[] = [];

  if (available.has('OPENAI_API_KEY')) {
    providers.push({
      id: 'openai',
      kind: 'openai',
      displayName: 'OpenAI',
      credential: { ref: 'OPENAI_API_KEY' },
      enabled: true,
      priority: 10,
    });
  }
  if (available.has('ANTHROPIC_API_KEY')) {
    providers.push({
      id: 'anthropic',
      kind: 'anthropic',
      displayName: 'Anthropic',
      credential: { ref: 'ANTHROPIC_API_KEY' },
      enabled: true,
      priority: 10,
    });
  }
  if (available.has('GOOGLE_AI_API_KEY')) {
    providers.push({
      id: 'google',
      kind: 'google',
      displayName: 'Google AI',
      credential: { ref: 'GOOGLE_AI_API_KEY' },
      enabled: true,
      priority: 20,
    });
  }
  if (available.has('OPENROUTER_API_KEY')) {
    providers.push({
      id: 'openrouter',
      kind: 'openrouter',
      displayName: 'OpenRouter',
      credential: { ref: 'OPENROUTER_API_KEY' },
      enabled: true,
      priority: 30,
    });
  }
  if (env.LOCAL_MODEL_BASE_URL) {
    providers.push({
      id: 'local',
      kind: 'local',
      displayName: 'Self-hosted',
      baseUrl: env.LOCAL_MODEL_BASE_URL,
      ...(available.has('LOCAL_MODEL_API_KEY')
        ? { credential: { ref: 'LOCAL_MODEL_API_KEY' } }
        : {}),
      enabled: true,
      priority: 5,
    });
  }
  if (mockProviderEnabled(env)) {
    providers.push({
      id: 'mock',
      kind: 'mock',
      displayName: 'Mock (synthetic, development only)',
      enabled: true,
      priority: 90,
    });
  }

  return providers;
}

/** Startup banner lines. Written to the log so an operator sees what is actually on. */
export function describeConfig(config: GatewayConfig): string[] {
  const lines = [
    `environment: ${config.nodeEnv}`,
    `store: ${config.databaseUrl ? 'postgres' : 'in-memory (not durable)'}`,
    `counters: ${config.redisUrl ? 'redis' : 'in-process (single replica only)'}`,
    `providers: ${config.providers.length ? config.providers.map((p) => p.id).join(', ') : 'none configured'}`,
  ];
  if (config.providers.length === 1 && config.providers[0]?.kind === 'mock') {
    lines.push(
      'note: only the synthetic mock provider is configured. Set a provider API key to route real traffic.',
    );
  }
  for (const secret of config.ephemeralSecrets) {
    lines.push(`warning: ${secret} was generated for this process only and will change on restart`);
  }
  for (const warning of config.warnings) {
    lines.push(`warning: ${warning.variable}: ${warning.message}`);
  }
  return lines;
}
