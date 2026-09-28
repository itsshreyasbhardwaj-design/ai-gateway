import { describe, expect, it } from 'vitest';
import { newId, type Organization, type Project, type RequestRecord } from '@ai-gateway/core';
import { MemoryStore } from './memory-store.js';
import type { ApiKeyLookup, Store } from './types.js';

function org(id = 'org_1'): Organization {
  return {
    id,
    name: `Org ${id}`,
    slug: id,
    createdAt: new Date().toISOString(),
    privacy: { mode: 'metadata_only', retentionDays: 30 },
    currency: 'USD',
  };
}

function project(organizationId: string, id = 'proj_1'): Project {
  return { id, organizationId, name: 'Production', slug: 'production', createdAt: new Date().toISOString() };
}

function apiKey(organizationId: string, projectId: string, id = 'key_1'): ApiKeyLookup {
  return {
    id,
    organizationId,
    projectId,
    name: 'CI',
    prefix: 'aigw_live_abcdef',
    hash: 'scrypt$1$2$3$salt$hash',
    lookupIndex: `idx_${id}`,
    scopes: ['inference.create'],
    createdAt: new Date().toISOString(),
  };
}

function request(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: newId('req'),
    organizationId: 'org_1',
    projectId: 'proj_1',
    apiKeyId: 'key_1',
    createdAt: new Date().toISOString(),
    endpoint: '/v1/chat/completions',
    requestedModel: 'gateway/auto',
    resolvedProviderId: 'mock',
    resolvedModelId: 'mock/mock-fast',
    status: 'success',
    httpStatus: 200,
    streamed: false,
    latencyMs: 42,
    cacheStatus: 'miss',
    fallbackUsed: false,
    attemptCount: 1,
    usage: { input: 10, output: 5, total: 15, source: 'provider_reported' },
    estimatedCost: 0.0001,
    currency: 'USD',
    pricingVersion: 'seed-unverified-v1',
    isTest: false,
    ...over,
  };
}

async function seeded(): Promise<Store> {
  const store = new MemoryStore();
  await store.migrate();
  await store.createOrganization(org('org_1'));
  await store.createOrganization(org('org_2'));
  await store.createProject(project('org_1'));
  await store.createProject(project('org_2', 'proj_2'));
  return store;
}

describe('store - tenancy', () => {
  it('round-trips an organization and looks it up by slug', async () => {
    const store = await seeded();
    expect((await store.getOrganization('org_1'))?.name).toBe('Org org_1');
    expect((await store.getOrganizationBySlug('org_1'))?.id).toBe('org_1');
    expect(await store.getOrganizationBySlug('nope')).toBeUndefined();
  });

  it('scopes projects to their organization', async () => {
    const store = await seeded();
    expect(await store.listProjects('org_1')).toHaveLength(1);
    expect(await store.listProjects('org_2')).toHaveLength(1);
  });

  it('patches an organization without losing untouched fields', async () => {
    const store = await seeded();
    const updated = await store.updateOrganization('org_1', { allowedModels: ['mock/mock-fast'] });
    expect(updated.allowedModels).toEqual(['mock/mock-fast']);
    expect(updated.currency).toBe('USD');
  });

  it('upserts a membership rather than duplicating it', async () => {
    const store = await seeded();
    const member = { organizationId: 'org_1', userId: 'user_1', role: 'member' as const, createdAt: new Date().toISOString() };
    await store.addMember(member);
    await store.addMember({ ...member, role: 'admin' });
    expect(await store.listMembers('org_1')).toHaveLength(1);
    expect((await store.getMembership('org_1', 'user_1'))?.role).toBe('admin');
  });
});

describe('store - api keys', () => {
  it('finds a key by its lookup index without scanning', async () => {
    const store = await seeded();
    await store.createApiKey(apiKey('org_1', 'proj_1'));
    expect((await store.findApiKeyByIndex('idx_key_1'))?.id).toBe('key_1');
    expect(await store.findApiKeyByIndex('idx_missing')).toBeUndefined();
  });

  it('never exposes the lookup index through the list endpoint', async () => {
    const store = await seeded();
    await store.createApiKey(apiKey('org_1', 'proj_1'));
    const listed = await store.listApiKeys('org_1');
    expect(listed[0]).not.toHaveProperty('lookupIndex');
    // The hash is present for admin tooling, but the plaintext never existed here.
    expect(listed[0]?.hash).toContain('scrypt$');
  });

  it('records revocation and last use', async () => {
    const store = await seeded();
    await store.createApiKey(apiKey('org_1', 'proj_1'));
    await store.touchApiKey('key_1', '2026-01-01T00:00:00.000Z');
    await store.revokeApiKey('key_1', '2026-01-02T00:00:00.000Z');
    const key = await store.getApiKey('key_1');
    expect(key?.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(key?.revokedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('filters keys by project', async () => {
    const store = await seeded();
    await store.createApiKey(apiKey('org_1', 'proj_1', 'key_a'));
    await store.createProject(project('org_1', 'proj_other'));
    await store.createApiKey(apiKey('org_1', 'proj_other', 'key_b'));
    expect(await store.listApiKeys('org_1', 'proj_1')).toHaveLength(1);
    expect(await store.listApiKeys('org_1')).toHaveLength(2);
  });
});

describe('store - providers and credentials', () => {
  it('keeps provider config scoped per organization', async () => {
    const store = await seeded();
    await store.upsertProvider('org_1', { id: 'openai', kind: 'openai', displayName: 'OpenAI', enabled: true });
    expect(await store.listProviders('org_1')).toHaveLength(1);
    expect(await store.listProviders('org_2')).toHaveLength(0);
    expect(await store.getProvider('org_2', 'openai')).toBeUndefined();
  });

  it('stores credentials as opaque ciphertext under a reference', async () => {
    const store = await seeded();
    await store.putProviderCredential('org_1', 'OPENAI_API_KEY', 'v1.iv.ct.tag');
    expect(await store.getProviderCredential('org_1', 'OPENAI_API_KEY')).toBe('v1.iv.ct.tag');
    // Another tenant's reference of the same name resolves to nothing.
    expect(await store.getProviderCredential('org_2', 'OPENAI_API_KEY')).toBeUndefined();
    expect(await store.listProviderCredentialRefs('org_1')).toEqual(['OPENAI_API_KEY']);
  });

  it('refuses to republish an existing pricing version', async () => {
    const store = await seeded();
    const snapshot = { version: 'v1', asOf: '2026-01-01', source: 'test', prices: {} };
    await store.publishPricing('org_1', snapshot);
    await expect(store.publishPricing('org_1', snapshot)).rejects.toThrow(/already exists/);
  });
});

describe('store - requests and traces', () => {
  it('stores a request with its trace and reads both back', async () => {
    const store = await seeded();
    const record = request();
    await store.recordRequest(
      record,
      [{ name: 'routing', status: 'ok', startedAt: 1, durationMs: 2, detail: { strategy: 'explicit' } }],
      [{ id: 'att_1', requestId: record.id, attemptNumber: 1, providerId: 'mock', modelId: 'mock/mock-fast', startedAt: 1, durationMs: 40, status: 'success' }],
    );
    const trace = await store.getRequestTrace('org_1', record.id);
    expect(trace?.request.id).toBe(record.id);
    expect(trace?.steps).toHaveLength(1);
    expect(trace?.attempts[0]?.providerId).toBe('mock');
  });

  it("refuses to return another organization's request", async () => {
    const store = await seeded();
    const record = request();
    await store.recordRequest(record, [], []);
    expect(await store.getRequest('org_2', record.id)).toBeUndefined();
    expect(await store.getRequestTrace('org_2', record.id)).toBeUndefined();
  });

  it('excludes test traffic from queries by default', async () => {
    const store = await seeded();
    await store.recordRequest(request(), [], []);
    await store.recordRequest(request({ isTest: true }), [], []);
    expect((await store.queryRequests({ organizationId: 'org_1' })).records).toHaveLength(1);
    expect((await store.queryRequests({ organizationId: 'org_1', includeTest: true })).records).toHaveLength(2);
  });

  it('filters by provider, model, status and project', async () => {
    const store = await seeded();
    await store.recordRequest(request({ resolvedProviderId: 'openai', resolvedModelId: 'openai/a' }), [], []);
    await store.recordRequest(request({ resolvedProviderId: 'anthropic', resolvedModelId: 'anthropic/b', status: 'error', errorType: 'provider_timeout' }), [], []);

    expect((await store.queryRequests({ organizationId: 'org_1', providerId: 'openai' })).records).toHaveLength(1);
    expect((await store.queryRequests({ organizationId: 'org_1', modelId: 'anthropic/b' })).records).toHaveLength(1);
    expect((await store.queryRequests({ organizationId: 'org_1', status: 'error' })).records).toHaveLength(1);
    expect((await store.queryRequests({ organizationId: 'org_1', projectId: 'nope' })).records).toHaveLength(0);
  });

  it('pages newest-first with a stable cursor', async () => {
    const store = await seeded();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const record = request();
      ids.push(record.id);
      await store.recordRequest(record, [], []);
    }
    const first = await store.queryRequests({ organizationId: 'org_1', limit: 4 });
    expect(first.records).toHaveLength(4);
    expect(first.records[0]?.id).toBe(ids.at(-1));
    expect(first.nextCursor).toBeDefined();

    const second = await store.queryRequests({ organizationId: 'org_1', limit: 4, cursor: first.nextCursor });
    expect(second.records).toHaveLength(4);
    // No overlap between pages.
    expect(second.records.map((r) => r.id).some((id) => first.records.some((r) => r.id === id))).toBe(false);
  });

  it('searches by request id and error type', async () => {
    const store = await seeded();
    const record = request({ errorType: 'provider_rate_limit', status: 'error' });
    await store.recordRequest(record, [], []);
    await store.recordRequest(request(), [], []);
    expect((await store.queryRequests({ organizationId: 'org_1', search: 'rate_limit' })).records).toHaveLength(1);
    expect((await store.queryRequests({ organizationId: 'org_1', search: record.id })).records).toHaveLength(1);
  });

  it('filters by time range', async () => {
    const store = await seeded();
    await store.recordRequest(request({ createdAt: '2026-01-01T00:00:00.000Z' }), [], []);
    await store.recordRequest(request({ createdAt: '2026-06-01T00:00:00.000Z' }), [], []);
    const result = await store.queryRequests({
      organizationId: 'org_1',
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-07-01T00:00:00Z'),
    });
    expect(result.records).toHaveLength(1);
  });

  it('bounds memory growth by evicting the oldest requests', async () => {
    const store = new MemoryStore(5);
    for (let i = 0; i < 20; i++) await store.recordRequest(request(), [], []);
    expect(store.requestCount).toBe(5);
  });
});

describe('store - prompt retention', () => {
  it('stores and expires prompt bodies independently of the request row', async () => {
    const store = await seeded();
    const record = request();
    await store.recordRequest(record, [], []);
    await store.putPromptBody({
      requestId: record.id,
      organizationId: 'org_1',
      request: { messages: [{ role: 'user', content: 'secret' }] },
      storedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    });
    expect(await store.getPromptBody('org_1', record.id)).toBeDefined();
    // Another tenant cannot read it even knowing the request id.
    expect(await store.getPromptBody('org_2', record.id)).toBeUndefined();

    expect(await store.prunePromptBodies(new Date('2026-01-03T00:00:00Z'))).toBe(1);
    expect(await store.getPromptBody('org_1', record.id)).toBeUndefined();
    // The request row itself survives, so analytics are unaffected by retention.
    expect(await store.getRequest('org_1', record.id)).toBeDefined();
  });
});

describe('store - policies', () => {
  it('keeps exactly one active version', async () => {
    const store = await seeded();
    const policyId = 'pol_1';
    await store.createPolicy(
      { id: policyId, organizationId: 'org_1', projectId: 'proj_1', name: 'prod', activeVersion: 1, createdAt: 'now', updatedAt: 'now' },
      { id: 'ver_1', policyId, version: 1, document: { name: 'v1' }, checksum: 'c1', createdBy: 'alice', active: true, createdAt: 'now' },
    );
    await store.addPolicyVersion({ id: 'ver_2', policyId, version: 2, document: { name: 'v2' }, checksum: 'c2', createdBy: 'bob', active: false, createdAt: 'now' });

    expect((await store.getActivePolicyVersion(policyId))?.version).toBe(1);
    await store.activatePolicyVersion(policyId, 2, 'later');
    expect((await store.getActivePolicyVersion(policyId))?.version).toBe(2);
    expect((await store.listPolicyVersions(policyId)).filter((v) => v.active)).toHaveLength(1);
    expect((await store.getPolicy(policyId))?.activeVersion).toBe(2);
  });

  it('rejects activating a version that does not exist', async () => {
    const store = await seeded();
    await store.createPolicy(
      { id: 'pol_1', organizationId: 'org_1', projectId: null, name: 'p', activeVersion: 1, createdAt: 'now', updatedAt: 'now' },
      { id: 'ver_1', policyId: 'pol_1', version: 1, document: {}, checksum: 'c', createdBy: 'a', active: true, createdAt: 'now' },
    );
    await expect(store.activatePolicyVersion('pol_1', 99, 'now')).rejects.toThrow(/unknown version/);
  });
});

describe('store - budgets, webhooks and audit', () => {
  it('scopes budgets and refuses cross-tenant deletion', async () => {
    const store = await seeded();
    const budget = { id: 'bud_1', organizationId: 'org_1', scope: 'organization' as const, period: 'monthly' as const, limit: 100, currency: 'USD', action: 'BLOCK' as const, enabled: true };
    await store.upsertBudget(budget);
    await store.deleteBudget('org_2', 'bud_1');
    expect(await store.listBudgets('org_1')).toHaveLength(1);
    await store.deleteBudget('org_1', 'bud_1');
    expect(await store.listBudgets('org_1')).toHaveLength(0);
  });

  it('claims only deliveries that are due', async () => {
    const store = await seeded();
    const base = { webhookId: 'whk_1', event: 'budget.exceeded' as const, payload: {}, attempts: 0, status: 'pending' as const, createdAt: '2026-01-01T00:00:00.000Z' };
    await store.enqueueDelivery({ ...base, id: 'd1' });
    await store.enqueueDelivery({ ...base, id: 'd2', nextAttemptAt: '2030-01-01T00:00:00.000Z' });
    await store.enqueueDelivery({ ...base, id: 'd3', status: 'delivered' });

    const claimed = await store.claimPendingDeliveries(new Date('2026-01-02T00:00:00Z'), 10);
    expect(claimed.map((d) => d.id)).toEqual(['d1']);
  });

  it('appends audit entries newest-first per organization', async () => {
    const store = await seeded();
    for (const [i, org] of ['org_1', 'org_2', 'org_1'].entries()) {
      await store.appendAuditLog({
        id: `aud_${i}`,
        organizationId: org,
        actorId: 'user_1',
        actorType: 'user',
        action: 'api_key.create',
        resourceType: 'api_key',
        resourceId: 'key_1',
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const entries = await store.listAuditLog('org_1');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toBe('aud_2');
  });
});
