import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type Organization, type Project, type RequestRecord } from '@ai-gateway/core';
import { PostgresStore, type ApiKeyLookup, type Store } from '@ai-gateway/database';
import { PGlitePool } from './pglite-pool.js';

/**
 * The PostgreSQL store against a real database.
 *
 * The in-memory store implements the same contract, but only a real database
 * exercises the SQL, the transaction boundaries, the partial unique index that
 * enforces one active policy version, and the row mappers. Those are exactly
 * the places a bug hides until production.
 *
 * Runs against a real PostgreSQL server when DATABASE_URL is set, and against
 * PGlite - PostgreSQL compiled to WASM - otherwise. Both execute the same SQL,
 * so the schema and queries are genuinely exercised with nothing installed;
 * CI additionally runs them against a real server, where concurrency behaves
 * as it does in production.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

describe(`PostgresStore (${DATABASE_URL ? 'server' : 'pglite'})`, () => {
  let store: Store;
  let pool: PGlitePool | undefined;
  let organizationId: string;
  let projectId: string;

  const org = (id: string): Organization => ({
    id,
    name: `Org ${id}`,
    slug: id.toLowerCase(),
    createdAt: new Date().toISOString(),
    privacy: { mode: 'metadata_only', retentionDays: 30 },
    currency: 'USD',
    allowedModels: null,
    deniedModels: [],
  });

  const project = (id: string, orgId: string): Project => ({
    id,
    organizationId: orgId,
    name: 'Production',
    slug: `production-${id.slice(-6)}`,
    createdAt: new Date().toISOString(),
  });

  const request = (over: Partial<RequestRecord> = {}): RequestRecord => ({
    id: newId('req'),
    organizationId,
    projectId,
    apiKeyId: 'key_integration',
    createdAt: new Date().toISOString(),
    endpoint: '/v1/chat/completions',
    requestedModel: 'gateway/auto',
    resolvedProviderId: 'mock',
    resolvedModelId: 'mock/mock-fast',
    strategy: 'highest_reliability',
    status: 'success',
    httpStatus: 200,
    streamed: false,
    latencyMs: 42,
    cacheStatus: 'miss',
    fallbackUsed: false,
    attemptCount: 1,
    usage: { input: 10, output: 5, total: 15, source: 'provider_reported' },
    estimatedCost: 0.000123,
    currency: 'USD',
    pricingVersion: 'test-v1',
    isTest: false,
    tags: ['integration'],
    ...over,
  });

  beforeAll(async () => {
    if (DATABASE_URL) {
      store = await PostgresStore.connect(DATABASE_URL);
    } else {
      pool = await PGlitePool.create();
      store = PostgresStore.wrap(pool as never);
    }
    await store.migrate();

    organizationId = newId('org');
    projectId = newId('proj');
    await store.createOrganization(org(organizationId));
    await store.createProject(project(projectId, organizationId));
  }, 60_000);

  afterAll(async () => {
    await store?.close();
  });

  it('reports which backend it ran against', () => {
    expect(store.kind).toBe('postgres');
  });

  it('applies the schema idempotently', async () => {
    // Running it twice is what makes "run migrations on every deploy" safe.
    await store.migrate();
    expect(await store.healthCheck()).toBe(true);
  });

  it('round-trips an organization through real SQL', async () => {
    const loaded = await store.getOrganization(organizationId);
    expect(loaded?.name).toContain('Org');
    expect(loaded?.privacy.mode).toBe('metadata_only');
    expect(loaded?.currency).toBe('USD');
    // JSONB and array columns map back to the right shapes.
    expect(loaded?.deniedModels).toEqual([]);
    expect(loaded?.allowedModels).toBeNull();
  });

  it('persists a request with its trace in one transaction', async () => {
    const record = request();
    await store.recordRequest(
      record,
      [
        {
          name: 'routing',
          status: 'ok',
          startedAt: 1,
          durationMs: 2,
          detail: { strategy: 'explicit' },
        },
        { name: 'provider_request', status: 'ok', startedAt: 3, durationMs: 40 },
      ],
      [
        {
          id: newId('att'),
          requestId: record.id,
          attemptNumber: 1,
          providerId: 'mock',
          modelId: 'mock/mock-fast',
          startedAt: 3,
          durationMs: 40,
          status: 'success',
          usage: { input: 10, output: 5, total: 15, source: 'provider_reported' },
        },
      ],
    );

    const trace = await store.getRequestTrace(organizationId, record.id);
    expect(trace?.request.id).toBe(record.id);
    expect(trace?.steps).toHaveLength(2);
    expect(trace?.steps[0]?.detail).toEqual({ strategy: 'explicit' });
    expect(trace?.attempts[0]?.usage?.source).toBe('provider_reported');
    // NUMERIC(20,10) round-trips without losing sub-cent precision.
    expect(trace?.request.estimatedCost).toBeCloseTo(0.000123, 9);
  });

  it('enforces tenant isolation in SQL, not just in application code', async () => {
    const record = request();
    await store.recordRequest(record, [], []);

    const otherOrg = newId('org');
    await store.createOrganization(org(otherOrg));

    expect(await store.getRequest(otherOrg, record.id)).toBeUndefined();
    expect(await store.getRequestTrace(otherOrg, record.id)).toBeUndefined();
    const foreign = await store.queryRequests({ organizationId: otherOrg });
    expect(foreign.records).toHaveLength(0);
  });

  it('pages newest-first with a stable cursor', async () => {
    const pagingOrg = newId('org');
    const pagingProject = newId('proj');
    await store.createOrganization(org(pagingOrg));
    await store.createProject(project(pagingProject, pagingOrg));

    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const record = request({ organizationId: pagingOrg, projectId: pagingProject });
      ids.push(record.id);
      await store.recordRequest(record, [], []);
    }

    const first = await store.queryRequests({ organizationId: pagingOrg, limit: 5 });
    expect(first.records).toHaveLength(5);
    expect(first.records[0]?.id).toBe(ids.at(-1));
    expect(first.nextCursor).toBeDefined();

    const second = await store.queryRequests({
      organizationId: pagingOrg,
      limit: 5,
      cursor: first.nextCursor,
    });
    expect(second.records).toHaveLength(5);
    const overlap = second.records.filter((r) => first.records.some((f) => f.id === r.id));
    expect(overlap).toHaveLength(0);
  });

  it('excludes test traffic unless asked', async () => {
    const testOrg = newId('org');
    const testProject = newId('proj');
    await store.createOrganization(org(testOrg));
    await store.createProject(project(testProject, testOrg));

    await store.recordRequest(request({ organizationId: testOrg, projectId: testProject }), [], []);
    await store.recordRequest(
      request({ organizationId: testOrg, projectId: testProject, isTest: true }),
      [],
      [],
    );

    expect((await store.queryRequests({ organizationId: testOrg })).records).toHaveLength(1);
    expect(
      (await store.queryRequests({ organizationId: testOrg, includeTest: true })).records,
    ).toHaveLength(2);
  });

  it('allows exactly one active policy version, enforced by the database', async () => {
    const policyId = newId('pol');
    const now = new Date().toISOString();

    await store.createPolicy(
      {
        id: policyId,
        organizationId,
        projectId: null,
        name: 'integration',
        activeVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId('ver'),
        policyId,
        version: 1,
        document: { name: 'v1' },
        checksum: 'c1',
        createdBy: 'test',
        active: true,
        createdAt: now,
      },
    );
    await store.addPolicyVersion({
      id: newId('ver'),
      policyId,
      version: 2,
      document: { name: 'v2' },
      checksum: 'c2',
      createdBy: 'test',
      active: false,
      createdAt: now,
    });

    await store.activatePolicyVersion(policyId, 2, new Date().toISOString());

    const versions = await store.listPolicyVersions(policyId);
    // The partial unique index makes two active rows impossible, not merely
    // unlikely.
    expect(versions.filter((v) => v.active)).toHaveLength(1);
    expect((await store.getActivePolicyVersion(policyId))?.version).toBe(2);
    expect((await store.getPolicy(policyId))?.activeVersion).toBe(2);
  });

  it('rolls back a failed policy activation', async () => {
    const policyId = newId('pol');
    const now = new Date().toISOString();
    await store.createPolicy(
      {
        id: policyId,
        organizationId,
        projectId: null,
        name: 'rollback',
        activeVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: newId('ver'),
        policyId,
        version: 1,
        document: {},
        checksum: 'c',
        createdBy: 'test',
        active: true,
        createdAt: now,
      },
    );

    await expect(store.activatePolicyVersion(policyId, 99, now)).rejects.toThrow();
    // Version 1 is still active: the transaction rolled back rather than
    // leaving the policy with no active version at all.
    expect((await store.getActivePolicyVersion(policyId))?.version).toBe(1);
  });

  it('stores credentials as ciphertext scoped per organization', async () => {
    await store.putProviderCredential(organizationId, 'TEST_KEY', 'v1.iv.ciphertext.tag');
    expect(await store.getProviderCredential(organizationId, 'TEST_KEY')).toBe(
      'v1.iv.ciphertext.tag',
    );

    const otherOrg = newId('org');
    await store.createOrganization(org(otherOrg));
    expect(await store.getProviderCredential(otherOrg, 'TEST_KEY')).toBeUndefined();
  });

  it('finds an API key by its lookup index with a single indexed read', async () => {
    const key: ApiKeyLookup = {
      id: newId('key'),
      organizationId,
      projectId,
      name: 'integration',
      prefix: 'aigw_test_abc123',
      hash: 'scrypt$16384$8$1$salt$hash',
      lookupIndex: `idx_${newId('key')}`,
      scopes: ['inference.create', 'admin'],
      createdAt: new Date().toISOString(),
    };
    await store.createApiKey(key);

    const found = await store.findApiKeyByIndex(key.lookupIndex);
    expect(found?.id).toBe(key.id);
    expect(found?.scopes).toEqual(['inference.create', 'admin']);

    // The list endpoint never returns the lookup index.
    const listed = await store.listApiKeys(organizationId);
    expect(listed.find((k) => k.id === key.id)).not.toHaveProperty('lookupIndex');
  });

  it('expires prompt bodies independently of the request row', async () => {
    const record = request();
    await store.recordRequest(record, [], []);
    await store.putPromptBody({
      requestId: record.id,
      organizationId,
      request: { messages: [{ role: 'user', content: 'sensitive' }] },
      storedAt: new Date(Date.now() - 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(await store.getPromptBody(organizationId, record.id)).toBeDefined();
    expect(await store.prunePromptBodies(new Date())).toBeGreaterThan(0);
    expect(await store.getPromptBody(organizationId, record.id)).toBeUndefined();
    // Retention removes the body, never the analytics row.
    expect(await store.getRequest(organizationId, record.id)).toBeDefined();
  });

  it('claims webhook deliveries without handing the same one to two workers', async () => {
    const webhookId = newId('whk');
    await store.upsertWebhook({
      id: webhookId,
      organizationId,
      url: 'https://hooks.example.com/integration',
      secretEncrypted: 'v1.iv.ct.tag',
      events: ['budget.exceeded'],
      enabled: true,
      consecutiveFailures: 0,
      createdAt: new Date().toISOString(),
    });

    const deliveryId = newId('whk');
    await store.enqueueDelivery({
      id: deliveryId,
      webhookId,
      event: 'budget.exceeded',
      payload: { organizationId, event: 'budget.exceeded' },
      attempts: 0,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const claimed = await store.claimPendingDeliveries(new Date(), 10);
    expect(claimed.some((d) => d.id === deliveryId)).toBe(true);

    await store.updateDelivery(deliveryId, {
      status: 'delivered',
      attempts: 1,
      deliveredAt: new Date().toISOString(),
    });
    const after = await store.claimPendingDeliveries(new Date(), 10);
    expect(after.some((d) => d.id === deliveryId)).toBe(false);
  });

  it('prunes old requests', async () => {
    const pruneOrg = newId('org');
    const pruneProject = newId('proj');
    await store.createOrganization(org(pruneOrg));
    await store.createProject(project(pruneProject, pruneOrg));

    await store.recordRequest(
      request({
        organizationId: pruneOrg,
        projectId: pruneProject,
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
      [],
      [],
    );
    await store.recordRequest(
      request({ organizationId: pruneOrg, projectId: pruneProject }),
      [],
      [],
    );

    const removed = await store.pruneRequests(pruneOrg, new Date('2021-01-01T00:00:00Z'));
    expect(removed).toBe(1);
    expect((await store.queryRequests({ organizationId: pruneOrg })).records).toHaveLength(1);
  });
});
