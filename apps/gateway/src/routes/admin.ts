import {
  GatewayError,
  maskSecret,
  newId,
  newRequestId,
  type ApiKeyScope,
  type ProviderConfig,
} from '@ai-gateway/core';
import type { AlertRule, WebhookEndpoint, WebhookEventType } from '@ai-gateway/database';
import { parsePolicy, PolicyVersionStore, parsePolicyOrThrow } from '@ai-gateway/policies';
import {
  compareProviders,
  groupBy,
  resolveRange,
  summarize,
  timeSeries,
  type TimeRange,
} from '@ai-gateway/usage';
import {
  assertSafeProviderUrl,
  generateApiKey,
  generateWebhookSecret,
  keyIndex,
} from '@ai-gateway/security';
import { buildProvider } from '@ai-gateway/providers';
import {
  ChainCredentialResolver,
  EnvCredentialResolver,
  MapCredentialResolver,
} from '@ai-gateway/provider-sdk';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireScopes, type AuthenticatedKey } from '../auth.js';
import type { GatewayContext } from '../context.js';
import { sendError } from '../errors.js';

/**
 * Administrative API.
 *
 * Everything here is scoped to the authenticated key's organization; there is
 * no "list all organizations" route reachable with a tenant credential. Writes
 * that change routing or spend behaviour are recorded in the audit log, and
 * secrets are returned exactly once at creation.
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
): Promise<void> {
  const policyStore = new PolicyVersionStore();

  const auth = async (
    request: FastifyRequest,
    ...scopes: ApiKeyScope[]
  ): Promise<AuthenticatedKey> => {
    const identity = await authenticate(
      { store: ctx.store, pepper: ctx.config.apiKeyPepper, cache: ctx.authCache },
      request.headers.authorization ?? (request.headers['x-api-key'] as string | undefined),
    );
    requireScopes(identity, ...scopes);
    return identity;
  };

  const audit = async (
    identity: AuthenticatedKey,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata?: Record<string, unknown>,
    ip?: string,
  ) => {
    await ctx.store
      .appendAuditLog({
        id: newId('aud'),
        organizationId: identity.organizationId,
        actorId: identity.apiKeyId,
        actorType: 'api_key',
        action,
        resourceType,
        resourceId,
        metadata,
        ip: ip ?? null,
        createdAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  };

  const handle = <T>(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    scopes: ApiKeyScope[],
    fn: (identity: AuthenticatedKey, request: FastifyRequest) => Promise<T>,
  ) => {
    app[method](path, async (request, reply) => {
      const requestId = newRequestId();
      try {
        const identity = await auth(request, ...scopes);
        const body = await fn(identity, request);
        reply.header('x-request-id', requestId);
        return reply.send(body);
      } catch (err) {
        return sendError(reply, err, requestId);
      }
    });
  };

  // ------------------------------------------------------------ providers

  handle('get', '/api/v1/providers', ['admin'], async (identity) => {
    const configured = await ctx.store.listProviders(identity.organizationId);
    const live = new Set(ctx.providers.listProviderIds());
    return {
      object: 'list',
      data: configured.map((provider) => ({
        ...provider,
        // A credential reference is safe to show; its value never leaves the env.
        credential: provider.credential ? { ref: provider.credential.ref, configured: true } : null,
        registered: live.has(provider.id),
        models: ctx.providers.listModels(provider.id).length,
        health: ctx.health.stats(provider.id),
      })),
    };
  });

  const providerInput = z.object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase alphanumeric with dashes'),
    kind: z.enum([
      'openai',
      'openai-compatible',
      'anthropic',
      'google',
      'openrouter',
      'local',
      'mock',
    ]),
    displayName: z.string().min(1).max(128),
    baseUrl: z.string().url().optional(),
    /** Reference to an env var or stored secret. Never a secret value. */
    credentialRef: z.string().max(128).optional(),
    /** Write-once secret value, encrypted before storage. */
    credentialValue: z.string().min(1).max(4096).optional(),
    headers: z.record(z.string().max(1024)).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    weight: z.number().positive().max(1000).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    enabled: z.boolean().default(true),
    /**
     * Models this provider serves. Required for a custom endpoint the gateway
     * has no seed catalog for - registering a provider with no models would
     * produce something that can never route.
     */
    models: z
      .array(
        z.object({
          providerModelId: z.string().min(1).max(256),
          displayName: z.string().min(1).max(128).optional(),
          contextWindow: z.number().int().min(1).default(8192),
          maxOutputTokens: z.number().int().min(1).optional(),
          capabilities: z
            .array(
              z.enum([
                'chat',
                'streaming',
                'tools',
                'vision',
                'structured-output',
                'json-mode',
                'embeddings',
                'reasoning',
              ]),
            )
            .min(1)
            .default(['chat', 'streaming']),
          family: z.string().max(64).optional(),
        }),
      )
      .max(200)
      .optional(),
  });

  handle('post', '/api/v1/providers', ['admin'], async (identity, request) => {
    const input = providerInput.parse(request.body);

    // Only an administrator can set an arbitrary base URL, and even then it is
    // SSRF-checked against the operator's allowlist before it is stored.
    if (input.baseUrl) {
      assertSafeProviderUrl(input.baseUrl, {
        allowedHosts: ctx.config.providerAllowedHosts,
        allowInsecureHttp: false,
      });
    }

    const credentialRef =
      input.credentialRef ??
      (input.credentialValue ? `PROVIDER_${input.id.toUpperCase()}_KEY` : undefined);
    if (input.credentialValue && credentialRef) {
      await ctx.store.putProviderCredential(
        identity.organizationId,
        credentialRef,
        // Bound to the provider id, so a stolen blob cannot be replayed elsewhere.
        ctx.secrets.encrypt(input.credentialValue, `provider:${input.id}`),
      );
    }

    const declaredModels = input.models?.map((model) => ({
      id: `${input.id}/${model.providerModelId}`,
      providerId: input.id,
      providerModelId: model.providerModelId,
      displayName: model.displayName ?? model.providerModelId,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
      status: 'available' as const,
      family: model.family,
    }));

    const config: ProviderConfig = {
      id: input.id,
      kind: input.kind,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      credential: credentialRef ? { ref: credentialRef } : undefined,
      headers: input.headers,
      timeoutMs: input.timeoutMs,
      weight: input.weight,
      priority: input.priority,
      enabled: input.enabled,
      ...(declaredModels?.length ? { models: declaredModels } : {}),
    };

    await ctx.store.upsertProvider(identity.organizationId, config);

    // Register immediately so the provider is usable without a restart.
    let registered = false;
    let registrationError: string | undefined;
    try {
      const stored = new MapCredentialResolver();
      if (credentialRef) {
        const encrypted = await ctx.store.getProviderCredential(
          identity.organizationId,
          credentialRef,
        );
        if (encrypted)
          stored.set(credentialRef, ctx.secrets.decrypt(encrypted, `provider:${input.id}`));
      }
      const built = await buildProvider({
        config,
        credentials: new ChainCredentialResolver([new EnvCredentialResolver(), stored]),
        urlGuard: { allowedHosts: ctx.config.providerAllowedHosts },
      });
      ctx.providers.unregister(config.id);
      ctx.providers.register(built.provider, built.models);
      for (const model of built.models) {
        await ctx.store.upsertModel(identity.organizationId, model).catch(() => undefined);
      }
      registered = true;
    } catch (err) {
      registrationError = (err as Error).message;
    }

    await audit(
      identity,
      'provider.upsert',
      'provider',
      config.id,
      { kind: config.kind, registered },
      request.ip,
    );

    return {
      ...config,
      credential: credentialRef ? { ref: credentialRef, configured: true } : null,
      registered,
      registrationError,
    };
  });

  handle('delete', '/api/v1/providers/:id', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    await ctx.store.deleteProvider(identity.organizationId, id);
    ctx.providers.unregister(id);
    await audit(identity, 'provider.delete', 'provider', id, undefined, request.ip);
    return { deleted: true, id };
  });

  handle('post', '/api/v1/providers/:id/health', ['admin'], async (_identity, request) => {
    const { id } = request.params as { id: string };
    const provider = ctx.providers.getProvider(id);
    if (!provider) throw new GatewayError('model_not_found', `Provider "${id}" is not registered.`);
    const probe = await provider.healthCheck();
    return { probe, measured: ctx.health.stats(id) };
  });

  // -------------------------------------------------------------- models

  handle('get', '/api/v1/models', ['models.read'], async (identity, request) => {
    const query = request.query as {
      provider?: string;
      capability?: string;
      status?: string;
      search?: string;
    };
    let models = ctx.providers.listModels(query.provider);
    if (query.capability)
      models = models.filter((m) => m.capabilities.includes(query.capability as never));
    if (query.status) models = models.filter((m) => m.status === query.status);
    if (query.search) {
      const needle = query.search.toLowerCase();
      models = models.filter(
        (m) => m.id.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle),
      );
    }

    const range = resolveRange('24h');
    const { records } = await ctx.store.queryRequests({
      organizationId: identity.organizationId,
      from: range.from,
      to: range.to,
      limit: 500,
    });
    const byModel = new Map(groupBy(records, 'model').map((g) => [g.key, g]));

    return {
      object: 'list',
      data: models.map((model) => {
        const pricing = ctx.pricing.toRecord(model.id);
        const measured = byModel.get(model.id);
        const health = ctx.health.stats(`${model.providerId}::${model.id}`);
        return {
          ...model,
          pricing: pricing
            ? { ...pricing, verified: pricing.source !== 'seed:unverified-illustrative' }
            : null,
          measured: measured
            ? {
                requests: measured.requests,
                avgLatencyMs: measured.avgLatencyMs,
                p95LatencyMs: measured.p95LatencyMs,
                successRate: measured.successRate,
                windowHours: 24,
              }
            : null,
          circuit: ctx.circuits.get(`${model.providerId}::${model.id}`).snapshot().state,
          healthState: health.state,
        };
      }),
      gateway: { pricingVersion: ctx.pricing.version, pricingAgeDays: ctx.pricing.ageInDays() },
    };
  });

  const modelInput = z.object({
    id: z.string().min(3).max(256),
    providerId: z.string().min(1),
    providerModelId: z.string().min(1),
    displayName: z.string().min(1).max(128),
    contextWindow: z.number().int().min(1),
    maxOutputTokens: z.number().int().min(1).optional(),
    capabilities: z
      .array(
        z.enum([
          'chat',
          'streaming',
          'tools',
          'vision',
          'structured-output',
          'json-mode',
          'embeddings',
          'reasoning',
        ]),
      )
      .min(1),
    status: z.enum(['available', 'degraded', 'deprecated', 'disabled']).default('available'),
    family: z.string().max(64).optional(),
    description: z.string().max(1024).optional(),
  });

  handle('post', '/api/v1/models', ['admin'], async (identity, request) => {
    const model = modelInput.parse(request.body);
    if (!ctx.providers.getProvider(model.providerId)) {
      throw new GatewayError(
        'invalid_request',
        `Provider "${model.providerId}" is not registered.`,
      );
    }
    const stored = await ctx.store.upsertModel(identity.organizationId, model);
    const existing = ctx.providers.listModels(model.providerId).filter((m) => m.id !== model.id);
    ctx.providers.setModels(model.providerId, [...existing, model]);
    await audit(
      identity,
      'model.upsert',
      'model',
      model.id,
      { providerId: model.providerId },
      request.ip,
    );
    return stored;
  });

  // ------------------------------------------------------------ pricing

  handle('get', '/api/v1/pricing/versions', ['admin'], async () => ({
    object: 'list',
    active: ctx.pricing.version,
    ageDays: ctx.pricing.ageInDays(),
    data: ctx.pricing.listVersions().map((snapshot) => ({
      version: snapshot.version,
      asOf: snapshot.asOf,
      source: snapshot.source,
      notes: snapshot.notes,
      modelCount: Object.keys(snapshot.prices).length,
    })),
  }));

  const pricingInput = z.object({
    version: z.string().min(1).max(64),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
    source: z.string().min(1).max(256),
    notes: z.string().max(1024).optional(),
    prices: z.record(
      z.object({
        inputPerMillionTokens: z.number().min(0),
        outputPerMillionTokens: z.number().min(0),
        cachedInputPerMillionTokens: z.number().min(0).optional(),
        currency: z.string().length(3),
      }),
    ),
  });

  /**
   * Publish a new pricing snapshot.
   *
   * Existing cost rows keep their old version, so historical spend does not
   * change retroactively when prices are corrected.
   */
  handle('post', '/api/v1/pricing/versions', ['admin'], async (identity, request) => {
    const snapshot = pricingInput.parse(request.body);
    ctx.pricing.publish(snapshot);
    await ctx.store.publishPricing(identity.organizationId, snapshot).catch(() => undefined);
    await audit(
      identity,
      'pricing.publish',
      'pricing_version',
      snapshot.version,
      {
        modelCount: Object.keys(snapshot.prices).length,
        source: snapshot.source,
      },
      request.ip,
    );
    return {
      published: snapshot.version,
      active: ctx.pricing.version,
      note: 'Existing cost records retain the pricing version they were computed with.',
    };
  });

  // ----------------------------------------------------------- projects

  handle('get', '/api/v1/projects', ['admin'], async (identity) => ({
    object: 'list',
    data: await ctx.store.listProjects(identity.organizationId),
  }));

  const projectInput = z.object({
    name: z.string().min(1).max(128),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    allowedModels: z.array(z.string()).nullable().optional(),
    deniedModels: z.array(z.string()).optional(),
    routingPolicyId: z.string().nullable().optional(),
  });

  handle('post', '/api/v1/projects', ['admin'], async (identity, request) => {
    const input = projectInput.parse(request.body);
    const project = await ctx.store.createProject({
      id: newId('proj'),
      organizationId: identity.organizationId,
      name: input.name,
      slug: input.slug,
      allowedModels: input.allowedModels ?? null,
      deniedModels: input.deniedModels ?? [],
      routingPolicyId: input.routingPolicyId ?? null,
      createdAt: new Date().toISOString(),
    });
    await audit(
      identity,
      'project.create',
      'project',
      project.id,
      { slug: project.slug },
      request.ip,
    );
    return project;
  });

  handle('patch', '/api/v1/projects/:id', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const existing = await ctx.store.getProject(id);
    if (!existing || existing.organizationId !== identity.organizationId) {
      throw new GatewayError('model_not_found', `Project "${id}" not found.`);
    }
    const patch = projectInput.partial().parse(request.body);
    const updated = await ctx.store.updateProject(id, patch);
    await audit(
      identity,
      'project.update',
      'project',
      id,
      { changed: Object.keys(patch) },
      request.ip,
    );
    return updated;
  });

  // ----------------------------------------------------------- api keys

  handle('get', '/api/v1/api-keys', ['admin'], async (identity, request) => {
    const query = request.query as { projectId?: string };
    const keys = await ctx.store.listApiKeys(identity.organizationId, query.projectId);
    return {
      object: 'list',
      data: keys.map(({ hash: _hash, ...key }) => ({
        ...key,
        // The hash is never returned; the prefix is what a UI shows.
        secretPreview: maskSecret(key.prefix, key.prefix.length),
        status: key.revokedAt
          ? 'revoked'
          : key.expiresAt && Date.parse(key.expiresAt) < Date.now()
            ? 'expired'
            : 'active',
      })),
    };
  });

  const apiKeyInput = z.object({
    name: z.string().min(1).max(128),
    projectId: z.string().min(1),
    scopes: z
      .array(z.enum(['models.read', 'inference.create', 'usage.read', 'logs.read', 'admin']))
      .min(1),
    expiresAt: z.string().datetime().optional(),
    environment: z.enum(['live', 'test']).default('live'),
  });

  /** The plaintext is returned exactly once here and never persisted. */
  handle('post', '/api/v1/api-keys', ['admin'], async (identity, request) => {
    const input = apiKeyInput.parse(request.body);
    const project = await ctx.store.getProject(input.projectId);
    if (!project || project.organizationId !== identity.organizationId) {
      throw new GatewayError(
        'invalid_request',
        `Project "${input.projectId}" does not belong to this organization.`,
      );
    }

    const generated = await generateApiKey(input.environment);
    const record = await ctx.store.createApiKey({
      id: newId('key'),
      organizationId: identity.organizationId,
      projectId: input.projectId,
      name: input.name,
      prefix: generated.prefix,
      hash: generated.hash,
      lookupIndex: keyIndex(generated.plaintext, ctx.config.apiKeyPepper),
      scopes: input.scopes,
      createdAt: new Date().toISOString(),
      createdBy: identity.apiKeyId,
      expiresAt: input.expiresAt ?? null,
    });

    await audit(
      identity,
      'api_key.create',
      'api_key',
      record.id,
      { scopes: input.scopes, projectId: input.projectId },
      request.ip,
    );

    return {
      id: record.id,
      name: record.name,
      prefix: generated.prefix,
      scopes: input.scopes,
      projectId: input.projectId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      secret: generated.plaintext,
      warning:
        'This is the only time the full key is shown. Store it now; it cannot be retrieved later.',
    };
  });

  handle('post', '/api/v1/api-keys/:id/rotate', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const existing = await ctx.store.getApiKey(id);
    if (!existing || existing.organizationId !== identity.organizationId) {
      throw new GatewayError('model_not_found', `API key "${id}" not found.`);
    }

    const generated = await generateApiKey(existing.prefix.includes('_test_') ? 'test' : 'live');
    const replacement = await ctx.store.createApiKey({
      ...existing,
      id: newId('key'),
      prefix: generated.prefix,
      hash: generated.hash,
      lookupIndex: keyIndex(generated.plaintext, ctx.config.apiKeyPepper),
      createdAt: new Date().toISOString(),
      createdBy: identity.apiKeyId,
      rotatedFrom: existing.id,
      revokedAt: null,
      lastUsedAt: null,
    });

    // The old key is revoked immediately. Callers needing overlap should create
    // a second key, use it, then revoke the first.
    await ctx.store.revokeApiKey(existing.id, new Date().toISOString());
    ctx.authCache.invalidateByKeyId(existing.id);
    await audit(
      identity,
      'api_key.rotate',
      'api_key',
      replacement.id,
      { rotatedFrom: existing.id },
      request.ip,
    );

    return {
      id: replacement.id,
      rotatedFrom: existing.id,
      prefix: generated.prefix,
      secret: generated.plaintext,
      warning: 'The previous key was revoked immediately. This secret is shown only once.',
    };
  });

  handle('delete', '/api/v1/api-keys/:id', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const existing = await ctx.store.getApiKey(id);
    if (!existing || existing.organizationId !== identity.organizationId) {
      throw new GatewayError('model_not_found', `API key "${id}" not found.`);
    }
    await ctx.store.revokeApiKey(id, new Date().toISOString());
    // Drop the cached verification immediately: revocation that takes effect
    // in 30 seconds is not revocation.
    ctx.authCache.invalidateByKeyId(id);
    await audit(identity, 'api_key.revoke', 'api_key', id, undefined, request.ip);
    return { revoked: true, id };
  });

  // ----------------------------------------------------- routing policies

  handle('get', '/api/v1/routing-policies', ['admin'], async (identity, request) => {
    const query = request.query as { projectId?: string };
    const policies = await ctx.store.listPolicies(identity.organizationId, query.projectId);
    return {
      object: 'list',
      data: await Promise.all(
        policies.map(async (policy) => ({
          ...policy,
          activeVersionDetail: await ctx.store.getActivePolicyVersion(policy.id),
        })),
      ),
    };
  });

  const policyInput = z.object({
    name: z.string().min(1).max(128),
    projectId: z.string().nullable().optional(),
    /** YAML or a JSON object. */
    document: z.union([z.string(), z.record(z.unknown())]),
    note: z.string().max(512).optional(),
  });

  /** Validate a policy without saving it. Powers the CLI validator and the editor. */
  handle('post', '/api/v1/routing-policies/validate', ['admin'], async (_identity, request) => {
    const { document } = z
      .object({ document: z.union([z.string(), z.record(z.unknown())]) })
      .parse(request.body);
    const result = parsePolicy(document);
    if (!result.ok) return { valid: false, errors: result.issues, warnings: result.warnings };
    return {
      valid: true,
      warnings: result.warnings,
      checksum: result.checksum,
      normalized: result.policy,
    };
  });

  handle('post', '/api/v1/routing-policies', ['admin'], async (identity, request) => {
    const input = policyInput.parse(request.body);
    const document = parsePolicyOrThrow(input.document);

    const { policy, version } = policyStore.create({
      organizationId: identity.organizationId,
      projectId: input.projectId ?? null,
      name: input.name,
      document,
      createdBy: identity.apiKeyId,
      note: input.note,
    });

    await ctx.store.createPolicy(
      { ...policy, projectId: policy.projectId ?? null },
      { ...version, document: version.document as unknown, note: version.note ?? null },
    );
    await audit(
      identity,
      'routing_policy.create',
      'routing_policy',
      policy.id,
      { name: policy.name, version: 1 },
      request.ip,
    );
    return { policy, version };
  });

  /**
   * Publish a new version. It is NOT activated by this call.
   *
   * Editing and deploying are separate deliberately: a typo in a policy editor
   * should not be able to reroute production traffic.
   */
  handle('post', '/api/v1/routing-policies/:id/versions', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const stored = await ctx.store.getPolicy(id);
    if (!stored || stored.organizationId !== identity.organizationId) {
      throw new GatewayError('model_not_found', `Routing policy "${id}" not found.`);
    }
    const input = policyInput.partial({ name: true }).parse(request.body);
    const document = parsePolicyOrThrow(input.document);
    const existingVersions = await ctx.store.listPolicyVersions(id);

    const version = {
      id: newId('ver'),
      policyId: id,
      version: existingVersions.length + 1,
      document: document as unknown,
      checksum: parsePolicy(document).ok
        ? (parsePolicy(document) as { checksum: string }).checksum
        : '',
      createdBy: identity.apiKeyId,
      note: input.note ?? null,
      active: false,
      createdAt: new Date().toISOString(),
    };
    await ctx.store.addPolicyVersion(version);
    await audit(
      identity,
      'routing_policy.publish_version',
      'routing_policy',
      id,
      { version: version.version },
      request.ip,
    );
    return {
      version,
      note: 'Published but not active. POST /api/v1/routing-policies/:id/activate to roll it out.',
    };
  });

  handle('post', '/api/v1/routing-policies/:id/activate', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const stored = await ctx.store.getPolicy(id);
    if (!stored || stored.organizationId !== identity.organizationId) {
      throw new GatewayError('model_not_found', `Routing policy "${id}" not found.`);
    }
    const { version } = z.object({ version: z.number().int().min(1) }).parse(request.body);
    await ctx.store.activatePolicyVersion(id, version, new Date().toISOString());
    await audit(
      identity,
      'routing_policy.activate',
      'routing_policy',
      id,
      { version, previousVersion: stored.activeVersion },
      request.ip,
    );
    return { activated: version, previousVersion: stored.activeVersion };
  });

  handle('get', '/api/v1/routing-policies/:id/versions', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const stored = await ctx.store.getPolicy(id);
    if (!stored || stored.organizationId !== identity.organizationId) {
      throw new GatewayError('model_not_found', `Routing policy "${id}" not found.`);
    }
    return { object: 'list', data: await ctx.store.listPolicyVersions(id) };
  });

  // ------------------------------------------------------------ budgets

  handle('get', '/api/v1/budgets', ['admin'], async (identity) => {
    const budgets = await ctx.store.listBudgets(identity.organizationId);
    const now = new Date();
    const { buildState } = await import('@ai-gateway/usage');
    return {
      object: 'list',
      data: await Promise.all(
        budgets.map(async (budget) =>
          buildState(budget, await ctx.spend.readForBudget(budget, now), now),
        ),
      ),
    };
  });

  const budgetInput = z.object({
    scope: z.enum(['organization', 'project', 'api_key']),
    scopeId: z.string().optional(),
    period: z.enum(['daily', 'monthly']),
    limit: z.number().positive(),
    currency: z.string().length(3).default('USD'),
    action: z.enum(['BLOCK', 'WARN', 'FALLBACK_TO_CHEAPER_MODEL']),
    warnThreshold: z.number().min(0).max(1).optional(),
    enabled: z.boolean().default(true),
  });

  handle('post', '/api/v1/budgets', ['admin'], async (identity, request) => {
    const input = budgetInput.parse(request.body);
    if (input.scope !== 'organization' && !input.scopeId) {
      throw new GatewayError('invalid_request', `A ${input.scope} budget requires a scopeId.`);
    }
    const budget = await ctx.store.upsertBudget({
      id: newId('bud'),
      organizationId: identity.organizationId,
      ...input,
    });
    await audit(
      identity,
      'budget.create',
      'budget',
      budget.id,
      { scope: budget.scope, limit: budget.limit, action: budget.action },
      request.ip,
    );
    return budget;
  });

  handle('delete', '/api/v1/budgets/:id', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    await ctx.store.deleteBudget(identity.organizationId, id);
    await audit(identity, 'budget.delete', 'budget', id, undefined, request.ip);
    return { deleted: true, id };
  });

  // ------------------------------------------------------------- usage

  handle('get', '/api/v1/usage', ['usage.read'], async (identity, request) => {
    const query = request.query as {
      range?: TimeRange;
      from?: string;
      to?: string;
      projectId?: string;
      includeTest?: string;
      groupBy?: string;
    };
    const range = resolveRange(
      query.range ?? '24h',
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined,
    );
    const includeTest = query.includeTest === 'true';

    const { records } = await ctx.store.queryRequests({
      organizationId: identity.organizationId,
      projectId: query.projectId,
      from: range.from,
      to: range.to,
      includeTest,
      limit: 500,
    });

    const organization = await ctx.store.getOrganization(identity.organizationId);
    const summary = summarize(records, { includeTest, currency: organization?.currency });

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        bucketMs: range.bucketMs,
      },
      includeTest,
      summary,
      series: timeSeries(records, range, { includeTest }),
      breakdown: {
        provider: groupBy(records, 'provider', { includeTest }),
        model: groupBy(records, 'model', { includeTest }),
        status: groupBy(records, 'status', { includeTest }),
        errorType: groupBy(records, 'errorType', { includeTest }),
        ...(query.groupBy === 'apiKey'
          ? { apiKey: groupBy(records, 'apiKey', { includeTest }) }
          : {}),
      },
      disclosure: {
        pricingVersion: ctx.pricing.version,
        pricingAgeDays: ctx.pricing.ageInDays(),
        estimatedUsageShare: summary.estimatedUsageShare,
        note: 'Costs are computed from the configured price table, not from provider invoices. The estimated-usage share is the portion of requests whose token counts the gateway approximated rather than received from the provider.',
      },
    };
  });

  handle('get', '/api/v1/usage/providers', ['usage.read'], async (identity, request) => {
    const query = request.query as { range?: TimeRange; includeTest?: string };
    const range = resolveRange(query.range ?? '24h');
    const { records } = await ctx.store.queryRequests({
      organizationId: identity.organizationId,
      from: range.from,
      to: range.to,
      includeTest: query.includeTest === 'true',
      limit: 500,
    });
    return {
      object: 'list',
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      data: compareProviders(records, range, { includeTest: query.includeTest === 'true' }),
      note: 'Raw measurements over the stated window. No composite score or model-quality ranking is produced.',
    };
  });

  // ---------------------------------------------------------- requests

  handle('get', '/api/v1/requests', ['logs.read'], async (identity, request) => {
    const query = request.query as Record<string, string | undefined>;
    const result = await ctx.store.queryRequests({
      organizationId: identity.organizationId,
      projectId: query['projectId'],
      apiKeyId: query['apiKeyId'],
      providerId: query['providerId'],
      modelId: query['modelId'],
      status: query['status'] as 'success' | 'error' | 'cancelled' | undefined,
      from: query['from'] ? new Date(query['from']) : undefined,
      to: query['to'] ? new Date(query['to']) : undefined,
      includeTest: query['includeTest'] === 'true',
      search: query['search'],
      limit: query['limit'] ? Number(query['limit']) : undefined,
      cursor: query['cursor'],
    });
    return { object: 'list', data: result.records, nextCursor: result.nextCursor };
  });

  handle('get', '/api/v1/requests/:id', ['logs.read'], async (identity, request) => {
    const { id } = request.params as { id: string };
    const trace = await ctx.store.getRequestTrace(identity.organizationId, id);
    if (!trace) throw new GatewayError('model_not_found', `Request "${id}" not found.`);

    // Bodies are a separate, explicitly-scoped read: seeing that a request
    // happened is a lower bar than seeing what was in it.
    const body = await ctx.store.getPromptBody(identity.organizationId, id);
    const organization = await ctx.store.getOrganization(identity.organizationId);

    return {
      ...trace,
      body: body ?? null,
      privacy: {
        mode: organization?.privacy.mode,
        retentionDays: organization?.privacy.retentionDays,
        bodyStored: !!body,
        note: body
          ? 'Request bodies are retained per the organization privacy setting.'
          : 'No request body is stored for this request under the current privacy setting.',
      },
    };
  });

  // --------------------------------------------------- webhooks + alerts

  handle('get', '/api/v1/webhooks', ['admin'], async (identity) => {
    const webhooks = await ctx.store.listWebhooks(identity.organizationId);
    // The secret is never returned, not even masked past its prefix.
    return {
      object: 'list',
      data: webhooks.map(({ secretEncrypted: _secret, ...webhook }) => ({
        ...webhook,
        secretConfigured: true,
      })),
    };
  });

  const webhookInput = z.object({
    url: z.string().url(),
    events: z
      .array(
        z.enum([
          'budget.warning',
          'budget.exceeded',
          'provider.degraded',
          'provider.recovered',
          'high_error_rate',
          'circuit.opened',
          'circuit.closed',
        ]),
      )
      .min(1),
    enabled: z.boolean().default(true),
  });

  handle('post', '/api/v1/webhooks', ['admin'], async (identity, request) => {
    const input = webhookInput.parse(request.body);
    // Webhook targets are outbound requests from inside the network, so the
    // same SSRF rules apply as to provider base URLs.
    assertSafeProviderUrl(input.url, { allowedHosts: ctx.config.providerAllowedHosts });

    const secret = generateWebhookSecret();
    const webhook: WebhookEndpoint = {
      id: newId('whk'),
      organizationId: identity.organizationId,
      url: input.url,
      secretEncrypted: ctx.secrets.encrypt(secret),
      events: input.events as WebhookEventType[],
      enabled: input.enabled,
      consecutiveFailures: 0,
      createdAt: new Date().toISOString(),
    };
    await ctx.store.upsertWebhook(webhook);
    await audit(
      identity,
      'webhook.create',
      'webhook',
      webhook.id,
      { url: input.url, events: input.events },
      request.ip,
    );

    const { secretEncrypted: _omit, ...safe } = webhook;
    return {
      ...safe,
      secret,
      warning:
        'Store this signing secret now; it is shown only once. Verify the x-aigw-signature header with it.',
    };
  });

  handle('delete', '/api/v1/webhooks/:id', ['admin'], async (identity, request) => {
    const { id } = request.params as { id: string };
    await ctx.store.deleteWebhook(identity.organizationId, id);
    await audit(identity, 'webhook.delete', 'webhook', id, undefined, request.ip);
    return { deleted: true, id };
  });

  handle('get', '/api/v1/alerts', ['admin'], async (identity) => ({
    object: 'list',
    rules: await ctx.store.listAlertRules(identity.organizationId),
    events: await ctx.store.listAlertEvents(identity.organizationId, 50),
  }));

  const alertInput = z.object({
    name: z.string().min(1).max(128),
    metric: z.enum([
      'error_rate',
      'p95_latency_ms',
      'monthly_cost',
      'provider_unavailable',
      'fallback_rate',
    ]),
    comparator: z.enum(['gt', 'lt']).default('gt'),
    threshold: z.number(),
    /** Minutes the condition must hold. Suppresses single-spike noise. */
    forMinutes: z.number().int().min(1).max(1440).default(5),
    cooldownMinutes: z.number().int().min(1).max(10080).default(30),
    enabled: z.boolean().default(true),
  });

  handle('post', '/api/v1/alerts', ['admin'], async (identity, request) => {
    const input = alertInput.parse(request.body);
    const rule: AlertRule = {
      id: newId('alr'),
      organizationId: identity.organizationId,
      ...input,
      createdAt: new Date().toISOString(),
    };
    await ctx.store.upsertAlertRule(rule);
    await audit(
      identity,
      'alert.create',
      'alert',
      rule.id,
      { metric: rule.metric, threshold: rule.threshold },
      request.ip,
    );
    return rule;
  });

  // -------------------------------------------------------------- audit

  handle('get', '/api/v1/audit-logs', ['admin'], async (identity, request) => {
    const query = request.query as { limit?: string };
    return {
      object: 'list',
      data: await ctx.store.listAuditLog(
        identity.organizationId,
        query.limit ? Number(query.limit) : 100,
      ),
    };
  });
}
