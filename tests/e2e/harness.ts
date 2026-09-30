import { DEFAULT_PRIVACY, newId, type Organization, type Project } from '@ai-gateway/core';
import { MemoryKV, SemanticCache } from '@ai-gateway/cache';
import { loadGatewayConfig, type GatewayConfig } from '@ai-gateway/config';
import { MemoryStore } from '@ai-gateway/database';
import { Logger, MemorySink } from '@ai-gateway/observability';
import { createSeedPricingBook } from '@ai-gateway/pricing';
import { ProviderRegistry } from '@ai-gateway/provider-sdk';
import { MockProvider, MOCK_MODELS } from '@ai-gateway/providers';
import { parsePolicyOrThrow, type RoutingPolicyDocument } from '@ai-gateway/policies';
import { generateApiKey, hashApiKey, keyIndex } from '@ai-gateway/security';
import { buildApp, buildContext, WebhookDispatcher, type GatewayContext } from '@ai-gateway/gateway';
import { SecretBox } from '@ai-gateway/security';
import type { FastifyInstance } from 'fastify';

export interface HarnessOptions {
  policy?: RoutingPolicyDocument | Record<string, unknown>;
  /** Provider ids to register as separate MockProvider instances. */
  providers?: string[];
  /** Enable the semantic cache with a deterministic toy embedder. */
  semanticCache?: boolean;
  /** Intercept webhook deliveries instead of making real HTTP calls. */
  captureWebhooks?: boolean;
  privacy?: Organization['privacy'];
  allowedModels?: string[] | null;
  deniedModels?: string[];
  scopes?: Array<'models.read' | 'inference.create' | 'usage.read' | 'logs.read' | 'admin'>;
  env?: Record<string, string>;
}

export interface Harness {
  app: FastifyInstance;
  ctx: GatewayContext;
  config: GatewayConfig;
  store: MemoryStore;
  logs: MemorySink;
  organization: Organization;
  project: Project;
  apiKey: string;
  /** Mock providers by id, for injecting failures. */
  mocks: Map<string, MockProvider>;
  webhookCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
  request(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<HarnessResponse>;
  chat(body: Record<string, unknown>, headers?: Record<string, string>): Promise<HarnessResponse>;
  stream(body: Record<string, unknown>): Promise<StreamResult>;
  close(): Promise<void>;
}

export interface HarnessResponse {
  status: number;
  headers: Record<string, string>;
  json<T = Record<string, unknown>>(): T;
  raw: string;
}

export interface StreamResult {
  status: number;
  headers: Record<string, string>;
  frames: string[];
  /** Parsed chunk payloads, excluding the receipt frame and [DONE]. */
  chunks: Array<Record<string, unknown>>;
  receipt?: Record<string, unknown>;
  text: string;
  errorFrame?: Record<string, unknown>;
  done: boolean;
}

const DEFAULT_POLICY_DOC = {
  name: 'e2e',
  routing: { strategy: 'explicit', models: ['mock/mock-fast', 'mock/mock-smart'] },
  fallback: { enabled: true, maxTargets: 3 },
  retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5, jitter: 'none' },
  limits: { timeoutMs: 5_000, maxOutputTokens: 4096 },
};

/**
 * Boots a complete gateway in-process: real pipeline, real router, real policy
 * engine, real HTTP surface. Only the provider (synthetic) and the storage
 * backends (in-memory) are substituted, which is exactly the seam the
 * architecture was designed around.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const logs = new MemorySink();
  const logger = new Logger(logs, 'debug');
  const store = new MemoryStore();
  const kv = new MemoryKV();

  const config = loadGatewayConfig({
    NODE_ENV: 'test',
    ENABLE_MOCK_PROVIDER: 'true',
    ENCRYPTION_KEY: 'e2e-test-encryption-key-0123456789',
    API_KEY_PEPPER: 'e2e-test-pepper-0123456789',
    LOG_LEVEL: 'debug',
    DEFAULT_REQUEST_TIMEOUT_MS: '5000',
    ...options.env,
  });

  const providers = new ProviderRegistry();
  const mocks = new Map<string, MockProvider>();
  for (const id of options.providers ?? ['mock']) {
    const provider = new MockProvider({
      id,
      behavior: { latencyMs: 0, chunkDelayMs: 0, reportUsage: true },
      models: MOCK_MODELS.map((m) => ({ ...m, providerId: id, id: `${id}/${m.providerModelId}` })),
    });
    const models = await provider.listModels();
    providers.register(provider, models);
    mocks.set(id, provider);
  }

  const webhookCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = options.captureWebhooks
    ? (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          headers[key] = value;
        });
        webhookCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers,
        });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch
    : undefined;

  const webhooks = new WebhookDispatcher({
    store,
    secrets: new SecretBox(config.encryptionKey),
    logger,
    fetchImpl,
  });

  const semanticCache = options.semanticCache
    ? new SemanticCache(new MemoryKV(), async (text) => toyEmbedding(text), { similarityThreshold: 0.85 })
    : undefined;

  const ctx = buildContext({
    config,
    logger,
    store,
    kv,
    providers,
    pricing: createSeedPricingBook(),
    webhooks,
    semanticCache,
    mockProvider: mocks.get('mock'),
  });

  // --- tenant -----------------------------------------------------------
  const organization: Organization = {
    id: newId('org'),
    name: 'E2E Org',
    slug: `e2e-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    privacy: options.privacy ?? DEFAULT_PRIVACY,
    currency: 'USD',
    allowedModels: options.allowedModels ?? null,
    deniedModels: options.deniedModels ?? [],
  };
  await store.createOrganization(organization);

  const policyDoc = parsePolicyOrThrow(options.policy ?? DEFAULT_POLICY_DOC);
  const policyId = newId('pol');
  await store.createPolicy(
    {
      id: policyId,
      organizationId: organization.id,
      projectId: null,
      name: policyDoc.name,
      activeVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: newId('ver'),
      policyId,
      version: 1,
      document: policyDoc,
      checksum: 'e2e',
      createdBy: 'harness',
      active: true,
      createdAt: new Date().toISOString(),
    },
  );

  const project: Project = {
    id: newId('proj'),
    organizationId: organization.id,
    name: 'E2E Project',
    slug: 'e2e',
    createdAt: new Date().toISOString(),
    routingPolicyId: policyId,
  };
  await store.createProject(project);

  const generated = await generateApiKey('test');
  await store.createApiKey({
    id: newId('key'),
    organizationId: organization.id,
    projectId: project.id,
    name: 'e2e key',
    prefix: generated.prefix,
    hash: generated.hash,
    lookupIndex: keyIndex(generated.plaintext, config.apiKeyPepper),
    scopes: options.scopes ?? ['models.read', 'inference.create', 'usage.read', 'logs.read', 'admin'],
    createdAt: new Date().toISOString(),
  });

  for (const model of providers.listModels()) {
    await store.upsertModel(organization.id, model);
  }

  const app = await buildApp(ctx);
  await app.ready();

  const inject = async (
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HarnessResponse> => {
    const response = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        authorization: `Bearer ${generated.plaintext}`,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
      raw: response.body,
      json<T>() {
        return JSON.parse(response.body) as T;
      },
    };
  };

  return {
    app,
    ctx,
    config,
    store,
    logs,
    organization,
    project,
    apiKey: generated.plaintext,
    mocks,
    webhookCalls,
    request: inject,
    chat: (body, headers) => inject('POST', '/v1/chat/completions', body, headers),
    async stream(body) {
      const response = await inject('POST', '/v1/chat/completions', { ...body, stream: true });
      return parseStream(response);
    },
    async close() {
      await app.close();
      await ctx.shutdown();
    },
  };
}

/** Split an SSE body into frames and classify them. */
export function parseStream(response: HarnessResponse): StreamResult {
  const frames = response.raw.split('\n\n').map((f) => f.trim()).filter(Boolean);
  const chunks: Array<Record<string, unknown>> = [];
  let receipt: Record<string, unknown> | undefined;
  let errorFrame: Record<string, unknown> | undefined;
  let text = '';
  let done = false;

  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['error']) {
      errorFrame = parsed;
      continue;
    }
    if (parsed['gateway'] && !parsed['choices']) {
      receipt = parsed['gateway'] as Record<string, unknown>;
      continue;
    }
    chunks.push(parsed);
    const choices = parsed['choices'] as Array<{ delta?: { content?: string } }> | undefined;
    const delta = choices?.[0]?.delta?.content;
    if (delta) text += delta;
  }

  return { status: response.status, headers: response.headers, frames, chunks, receipt, text, errorFrame, done };
}

/** Deterministic toy embedding over a small vocabulary, for semantic-cache tests. */
export function toyEmbedding(text: string): number[] {
  const vocab = ['capital', 'france', 'paris', 'weather', 'pune', 'python', 'recursion', 'explain', 'sql', 'query'];
  const lowered = text.toLowerCase();
  const vector = vocab.map((word) => (lowered.includes(word) ? 1 : 0));
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}
