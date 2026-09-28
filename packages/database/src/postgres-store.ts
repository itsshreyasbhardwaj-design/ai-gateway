import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApiKeyRecord,
  ApiKeyScope,
  ModelDescriptor,
  Organization,
  OrganizationMember,
  Project,
  ProviderConfig,
  RequestAttempt,
  RequestRecord,
  TraceStep,
} from '@ai-gateway/core';
import type { Budget } from '@ai-gateway/usage';
import type { PricingSnapshot } from '@ai-gateway/pricing';
import type {
  AlertEvent,
  AlertRule,
  ApiKeyLookup,
  AuditLogEntry,
  PolicyVersionRow,
  ProviderHealthSnapshot,
  RequestQuery,
  Store,
  StoredPolicyRow,
  StoredPromptBody,
  WebhookDelivery,
  WebhookEndpoint,
} from './types.js';

type QueryResult<T> = { rows: T[]; rowCount: number | null };
type PoolLike = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
};
type ClientLike = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;

/**
 * PostgreSQL-backed store.
 *
 * `pg` is imported lazily so a memory-store deployment never loads a database
 * driver. Every tenant-scoped query carries organization_id in its WHERE
 * clause; the row-level security policies in the migration are a second line
 * of defence, not the first.
 */
export class PostgresStore implements Store {
  readonly kind = 'postgres' as const;

  private constructor(private readonly pool: PoolLike) {}

  static async connect(connectionString: string, options: Record<string, unknown> = {}): Promise<PostgresStore> {
    const pg = (await import('pg')) as unknown as {
      default?: { Pool: new (config: Record<string, unknown>) => PoolLike };
      Pool?: new (config: Record<string, unknown>) => PoolLike;
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('could not load the pg Pool constructor');
    const pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...options,
    });
    return new PostgresStore(pool);
  }

  static wrap(pool: PoolLike): PostgresStore {
    return new PostgresStore(pool);
  }

  async migrate(): Promise<void> {
    const sql = await readFile(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // --- tenancy -------------------------------------------------------

  async createOrganization(org: Organization): Promise<Organization> {
    await this.pool.query(
      `INSERT INTO organizations (id, name, slug, currency, privacy, allowed_models, denied_models, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [org.id, org.name, org.slug, org.currency, JSON.stringify(org.privacy), org.allowedModels ?? null, org.deniedModels ?? [], org.createdAt],
    );
    return org;
  }

  async getOrganization(id: string): Promise<Organization | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
    return rows[0] ? mapOrganization(rows[0]) : undefined;
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM organizations WHERE slug = $1', [slug]);
    return rows[0] ? mapOrganization(rows[0]) : undefined;
  }

  async updateOrganization(id: string, patch: Partial<Organization>): Promise<Organization> {
    const current = await this.getOrganization(id);
    if (!current) throw new Error(`unknown organization: ${id}`);
    const next = { ...current, ...patch, id };
    await this.pool.query(
      `UPDATE organizations SET name=$2, slug=$3, currency=$4, privacy=$5, allowed_models=$6, denied_models=$7 WHERE id=$1`,
      [id, next.name, next.slug, next.currency, JSON.stringify(next.privacy), next.allowedModels ?? null, next.deniedModels ?? []],
    );
    return next;
  }

  async listOrganizations(): Promise<Organization[]> {
    const { rows } = await this.pool.query('SELECT * FROM organizations ORDER BY created_at');
    return rows.map(mapOrganization);
  }

  async addMember(member: OrganizationMember): Promise<OrganizationMember> {
    await this.pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [member.organizationId, member.userId, member.role, member.createdAt],
    );
    return member;
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const { rows } = await this.pool.query('SELECT * FROM organization_members WHERE organization_id=$1', [organizationId]);
    return rows.map((r) => ({
      organizationId: String(r['organization_id']),
      userId: String(r['user_id']),
      role: r['role'] as OrganizationMember['role'],
      createdAt: isoOf(r['created_at']),
    }));
  }

  async getMembership(organizationId: string, userId: string): Promise<OrganizationMember | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM organization_members WHERE organization_id=$1 AND user_id=$2',
      [organizationId, userId],
    );
    const row = rows[0];
    return row
      ? {
          organizationId: String(row['organization_id']),
          userId: String(row['user_id']),
          role: row['role'] as OrganizationMember['role'],
          createdAt: isoOf(row['created_at']),
        }
      : undefined;
  }

  async createProject(project: Project): Promise<Project> {
    await this.pool.query(
      `INSERT INTO projects (id, organization_id, name, slug, allowed_models, denied_models, routing_policy_id, privacy, archived, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        project.id, project.organizationId, project.name, project.slug,
        project.allowedModels ?? null, project.deniedModels ?? [], project.routingPolicyId ?? null,
        project.privacy ? JSON.stringify(project.privacy) : null, project.archived ?? false, project.createdAt,
      ],
    );
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM projects WHERE id=$1', [id]);
    return rows[0] ? mapProject(rows[0]) : undefined;
  }

  async listProjects(organizationId: string): Promise<Project[]> {
    const { rows } = await this.pool.query('SELECT * FROM projects WHERE organization_id=$1 ORDER BY created_at', [organizationId]);
    return rows.map(mapProject);
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const current = await this.getProject(id);
    if (!current) throw new Error(`unknown project: ${id}`);
    const next = { ...current, ...patch, id };
    await this.pool.query(
      `UPDATE projects SET name=$2, slug=$3, allowed_models=$4, denied_models=$5, routing_policy_id=$6, privacy=$7, archived=$8 WHERE id=$1`,
      [
        id, next.name, next.slug, next.allowedModels ?? null, next.deniedModels ?? [],
        next.routingPolicyId ?? null, next.privacy ? JSON.stringify(next.privacy) : null, next.archived ?? false,
      ],
    );
    return next;
  }

  // --- api keys ------------------------------------------------------

  async createApiKey(key: ApiKeyLookup): Promise<ApiKeyRecord> {
    await this.pool.query(
      `INSERT INTO api_keys (id, organization_id, project_id, name, prefix, hash, lookup_index, scopes, created_by, rotated_from, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        key.id, key.organizationId, key.projectId, key.name, key.prefix, key.hash, key.lookupIndex,
        key.scopes, key.createdBy ?? null, key.rotatedFrom ?? null, key.expiresAt ?? null, key.createdAt,
      ],
    );
    return key;
  }

  async findApiKeyByIndex(lookupIndex: string): Promise<ApiKeyLookup | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE lookup_index=$1', [lookupIndex]);
    return rows[0] ? mapApiKey(rows[0]) : undefined;
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE id=$1', [id]);
    return rows[0] ? mapApiKey(rows[0]) : undefined;
  }

  async listApiKeys(organizationId: string, projectId?: string): Promise<ApiKeyRecord[]> {
    const { rows } = projectId
      ? await this.pool.query('SELECT * FROM api_keys WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC', [organizationId, projectId])
      : await this.pool.query('SELECT * FROM api_keys WHERE organization_id=$1 ORDER BY created_at DESC', [organizationId]);
    // The lookup index is a lookup secret; it never leaves the store.
    return rows.map((r) => {
      const { lookupIndex: _lookupIndex, ...rest } = mapApiKey(r);
      return rest;
    });
  }

  async revokeApiKey(id: string, at: string): Promise<void> {
    await this.pool.query('UPDATE api_keys SET revoked_at=$2 WHERE id=$1', [id, at]);
  }

  async touchApiKey(id: string, at: string): Promise<void> {
    await this.pool.query('UPDATE api_keys SET last_used_at=$2 WHERE id=$1', [id, at]);
  }

  async updateApiKeyScopes(id: string, scopes: ApiKeyScope[]): Promise<void> {
    await this.pool.query('UPDATE api_keys SET scopes=$2 WHERE id=$1', [id, scopes]);
  }

  // --- providers and models -----------------------------------------

  async upsertProvider(organizationId: string, config: ProviderConfig): Promise<ProviderConfig> {
    await this.pool.query(
      `INSERT INTO providers (organization_id, id, kind, display_name, base_url, credential_ref, headers, timeout_ms, weight, priority, enabled, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (organization_id, id) DO UPDATE SET
         kind=EXCLUDED.kind, display_name=EXCLUDED.display_name, base_url=EXCLUDED.base_url,
         credential_ref=EXCLUDED.credential_ref, headers=EXCLUDED.headers, timeout_ms=EXCLUDED.timeout_ms,
         weight=EXCLUDED.weight, priority=EXCLUDED.priority, enabled=EXCLUDED.enabled, updated_at=now()`,
      [
        organizationId, config.id, config.kind, config.displayName, config.baseUrl ?? null,
        config.credential?.ref ?? null, config.headers ? JSON.stringify(config.headers) : null,
        config.timeoutMs ?? null, config.weight ?? null, config.priority ?? null, config.enabled,
      ],
    );
    return config;
  }

  async listProviders(organizationId: string): Promise<ProviderConfig[]> {
    const { rows } = await this.pool.query('SELECT * FROM providers WHERE organization_id=$1 ORDER BY id', [organizationId]);
    return rows.map(mapProvider);
  }

  async getProvider(organizationId: string, id: string): Promise<ProviderConfig | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM providers WHERE organization_id=$1 AND id=$2', [organizationId, id]);
    return rows[0] ? mapProvider(rows[0]) : undefined;
  }

  async deleteProvider(organizationId: string, id: string): Promise<void> {
    await this.pool.query('DELETE FROM providers WHERE organization_id=$1 AND id=$2', [organizationId, id]);
  }

  async putProviderCredential(organizationId: string, ref: string, encrypted: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_credentials (organization_id, ref, encrypted, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (organization_id, ref) DO UPDATE SET encrypted=EXCLUDED.encrypted, updated_at=now()`,
      [organizationId, ref, encrypted],
    );
  }

  async getProviderCredential(organizationId: string, ref: string): Promise<string | undefined> {
    const { rows } = await this.pool.query('SELECT encrypted FROM provider_credentials WHERE organization_id=$1 AND ref=$2', [organizationId, ref]);
    return rows[0] ? String(rows[0]['encrypted']) : undefined;
  }

  async listProviderCredentialRefs(organizationId: string): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT ref FROM provider_credentials WHERE organization_id=$1 ORDER BY ref', [organizationId]);
    return rows.map((r) => String(r['ref']));
  }

  async upsertModel(organizationId: string, model: ModelDescriptor): Promise<ModelDescriptor> {
    await this.pool.query(
      `INSERT INTO models (organization_id, id, provider_id, provider_model_id, display_name, context_window, max_output_tokens, capabilities, status, family, description, deprecated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (organization_id, id) DO UPDATE SET
         provider_id=EXCLUDED.provider_id, provider_model_id=EXCLUDED.provider_model_id,
         display_name=EXCLUDED.display_name, context_window=EXCLUDED.context_window,
         max_output_tokens=EXCLUDED.max_output_tokens, capabilities=EXCLUDED.capabilities,
         status=EXCLUDED.status, family=EXCLUDED.family, description=EXCLUDED.description,
         deprecated_at=EXCLUDED.deprecated_at`,
      [
        organizationId, model.id, model.providerId, model.providerModelId, model.displayName,
        model.contextWindow, model.maxOutputTokens ?? null, model.capabilities, model.status,
        model.family ?? null, model.description ?? null, model.deprecatedAt ?? null,
      ],
    );
    return model;
  }

  async listModels(organizationId: string): Promise<ModelDescriptor[]> {
    const { rows } = await this.pool.query('SELECT * FROM models WHERE organization_id=$1 ORDER BY id', [organizationId]);
    return rows.map(mapModel);
  }

  async deleteModel(organizationId: string, modelId: string): Promise<void> {
    await this.pool.query('DELETE FROM models WHERE organization_id=$1 AND id=$2', [organizationId, modelId]);
  }

  async publishPricing(organizationId: string, snapshot: PricingSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO pricing_versions (organization_id, version, as_of, source, notes, prices) VALUES ($1,$2,$3,$4,$5,$6)`,
      [organizationId, snapshot.version, snapshot.asOf, snapshot.source, snapshot.notes ?? null, JSON.stringify(snapshot.prices)],
    );
  }

  async listPricingSnapshots(organizationId: string): Promise<PricingSnapshot[]> {
    const { rows } = await this.pool.query('SELECT * FROM pricing_versions WHERE organization_id=$1 ORDER BY as_of', [organizationId]);
    return rows.map((r) => ({
      version: String(r['version']),
      asOf: isoOf(r['as_of']).slice(0, 10),
      source: String(r['source']),
      notes: (r['notes'] as string | null) ?? undefined,
      prices: r['prices'] as PricingSnapshot['prices'],
    }));
  }

  // --- policies ------------------------------------------------------

  async createPolicy(row: StoredPolicyRow, version: PolicyVersionRow): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO routing_policies (id, organization_id, project_id, name, active_version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [row.id, row.organizationId, row.projectId, row.name, row.activeVersion, row.createdAt, row.updatedAt],
      );
      await client.query(
        `INSERT INTO routing_policy_versions (id, policy_id, version, document, checksum, created_by, note, active, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [version.id, version.policyId, version.version, JSON.stringify(version.document), version.checksum, version.createdBy, version.note ?? null, version.active, version.createdAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addPolicyVersion(version: PolicyVersionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO routing_policy_versions (id, policy_id, version, document, checksum, created_by, note, active, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [version.id, version.policyId, version.version, JSON.stringify(version.document), version.checksum, version.createdBy, version.note ?? null, false, version.createdAt],
    );
  }

  /** Deactivate then activate inside one transaction: the partial unique index forbids two active rows. */
  async activatePolicyVersion(policyId: string, version: number, at: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE routing_policy_versions SET active=FALSE WHERE policy_id=$1 AND active', [policyId]);
      const result = await client.query('UPDATE routing_policy_versions SET active=TRUE WHERE policy_id=$1 AND version=$2', [policyId, version]);
      if (!result.rowCount) throw new Error(`unknown version ${version} for policy ${policyId}`);
      await client.query('UPDATE routing_policies SET active_version=$2, updated_at=$3 WHERE id=$1', [policyId, version, at]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getPolicy(id: string): Promise<StoredPolicyRow | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM routing_policies WHERE id=$1', [id]);
    return rows[0] ? mapPolicy(rows[0]) : undefined;
  }

  async listPolicies(organizationId: string, projectId?: string): Promise<StoredPolicyRow[]> {
    const { rows } = projectId
      ? await this.pool.query('SELECT * FROM routing_policies WHERE organization_id=$1 AND project_id=$2', [organizationId, projectId])
      : await this.pool.query('SELECT * FROM routing_policies WHERE organization_id=$1', [organizationId]);
    return rows.map(mapPolicy);
  }

  async getActivePolicyVersion(policyId: string): Promise<PolicyVersionRow | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM routing_policy_versions WHERE policy_id=$1 AND active', [policyId]);
    return rows[0] ? mapPolicyVersion(rows[0]) : undefined;
  }

  async listPolicyVersions(policyId: string): Promise<PolicyVersionRow[]> {
    const { rows } = await this.pool.query('SELECT * FROM routing_policy_versions WHERE policy_id=$1 ORDER BY version', [policyId]);
    return rows.map(mapPolicyVersion);
  }

  // --- requests ------------------------------------------------------

  /** One transaction: a trace without its request row would be unreadable. */
  async recordRequest(record: RequestRecord, steps: TraceStep[], attempts: RequestAttempt[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO requests (
           id, organization_id, project_id, api_key_id, endpoint, requested_model,
           resolved_provider_id, resolved_model_id, strategy, status, error_type, error_message,
           http_status, streamed, latency_ms, time_to_first_token_ms, cache_status, cache_similarity,
           fallback_used, attempt_count, input_tokens, output_tokens, total_tokens, cached_input_tokens,
           usage_source, estimated_cost, currency, pricing_version, is_test, tags, routing_reasons,
           prompt_ref, user_agent, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
        [
          record.id, record.organizationId, record.projectId, record.apiKeyId, record.endpoint, record.requestedModel,
          record.resolvedProviderId ?? null, record.resolvedModelId ?? null, record.strategy ?? null, record.status,
          record.errorType ?? null, record.errorMessage ?? null, record.httpStatus, record.streamed, record.latencyMs,
          record.timeToFirstTokenMs ?? null, record.cacheStatus, record.cacheSimilarity ?? null, record.fallbackUsed,
          record.attemptCount, record.usage?.input ?? null, record.usage?.output ?? null, record.usage?.total ?? null,
          record.usage?.cachedInput ?? null, record.usage?.source ?? null, record.estimatedCost ?? null,
          record.currency ?? null, record.pricingVersion ?? null, record.isTest, record.tags ?? [],
          record.routingReasons ?? null, record.promptRef ?? null, record.userAgent ?? null, record.createdAt,
        ],
      );

      for (const attempt of attempts) {
        await client.query(
          `INSERT INTO request_attempts (
             id, request_id, organization_id, attempt_number, provider_id, model_id, started_at, duration_ms,
             status, error_type, error_message, provider_status, retry_after_seconds, time_to_first_token_ms,
             backoff_ms, input_tokens, output_tokens, usage_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            attempt.id, attempt.requestId, record.organizationId, attempt.attemptNumber, attempt.providerId,
            attempt.modelId, attempt.startedAt, attempt.durationMs, attempt.status, attempt.errorType ?? null,
            attempt.errorMessage ?? null, attempt.providerStatus ?? null, attempt.httpRetryAfterSeconds ?? null,
            attempt.timeToFirstTokenMs ?? null, attempt.backoffMs ?? null, attempt.usage?.input ?? null,
            attempt.usage?.output ?? null, attempt.usage?.source ?? null,
          ],
        );
      }

      for (const [seq, step] of steps.entries()) {
        await client.query(
          `INSERT INTO request_events (request_id, organization_id, seq, name, status, started_at, duration_ms, error_type, message, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            record.id, record.organizationId, seq, step.name, step.status, step.startedAt, step.durationMs,
            step.errorType ?? null, step.message ?? null, step.detail ? JSON.stringify(step.detail) : null,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getRequest(organizationId: string, requestId: string): Promise<RequestRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM requests WHERE organization_id=$1 AND id=$2', [organizationId, requestId]);
    return rows[0] ? mapRequest(rows[0]) : undefined;
  }

  async getRequestTrace(organizationId: string, requestId: string) {
    const request = await this.getRequest(organizationId, requestId);
    if (!request) return undefined;
    const [attempts, events] = await Promise.all([
      this.pool.query('SELECT * FROM request_attempts WHERE request_id=$1 AND organization_id=$2 ORDER BY attempt_number', [requestId, organizationId]),
      this.pool.query('SELECT * FROM request_events WHERE request_id=$1 AND organization_id=$2 ORDER BY seq', [requestId, organizationId]),
    ]);
    return {
      request,
      attempts: attempts.rows.map(mapAttempt),
      steps: events.rows.map(mapStep),
    };
  }

  async queryRequests(query: RequestQuery): Promise<{ records: RequestRecord[]; nextCursor?: string }> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const where: string[] = ['organization_id = $1'];
    const values: unknown[] = [query.organizationId];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };

    if (query.projectId) add('project_id = ?', query.projectId);
    if (query.apiKeyId) add('api_key_id = ?', query.apiKeyId);
    if (query.providerId) add('resolved_provider_id = ?', query.providerId);
    if (query.modelId) add('resolved_model_id = ?', query.modelId);
    if (query.status) add('status = ?', query.status);
    if (query.from) add('created_at >= ?', query.from.toISOString());
    if (query.to) add('created_at <= ?', query.to.toISOString());
    if (!query.includeTest) where.push('is_test = FALSE');
    if (query.cursor) add('id < ?', query.cursor);
    if (query.search) {
      values.push(`%${query.search}%`);
      const p = `$${values.length}`;
      where.push(`(id ILIKE ${p} OR requested_model ILIKE ${p} OR resolved_model_id ILIKE ${p} OR error_type ILIKE ${p})`);
    }

    values.push(limit + 1);
    const { rows } = await this.pool.query(
      `SELECT * FROM requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${values.length}`,
      values,
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(mapRequest);
    return { records: page, nextCursor: hasMore ? page.at(-1)?.id : undefined };
  }

  async pruneRequests(organizationId: string, olderThan: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM requests WHERE organization_id=$1 AND created_at < $2', [
      organizationId,
      olderThan.toISOString(),
    ]);
    return rowCount ?? 0;
  }

  async putPromptBody(body: StoredPromptBody): Promise<void> {
    await this.pool.query(
      `INSERT INTO request_bodies (request_id, organization_id, request_body, response_body, stored_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (request_id) DO UPDATE SET request_body=EXCLUDED.request_body, response_body=EXCLUDED.response_body, expires_at=EXCLUDED.expires_at`,
      [
        body.requestId, body.organizationId,
        body.request === undefined ? null : JSON.stringify(body.request),
        body.response === undefined ? null : JSON.stringify(body.response),
        body.storedAt, body.expiresAt,
      ],
    );
  }

  async getPromptBody(organizationId: string, requestId: string): Promise<StoredPromptBody | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM request_bodies WHERE organization_id=$1 AND request_id=$2', [organizationId, requestId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      requestId: String(row['request_id']),
      organizationId: String(row['organization_id']),
      request: row['request_body'] ?? undefined,
      response: row['response_body'] ?? undefined,
      storedAt: isoOf(row['stored_at']),
      expiresAt: isoOf(row['expires_at']),
    };
  }

  async prunePromptBodies(now: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM request_bodies WHERE expires_at <= $1', [now.toISOString()]);
    return rowCount ?? 0;
  }

  // --- budgets, alerts, webhooks -------------------------------------

  async upsertBudget(budget: Budget): Promise<Budget> {
    await this.pool.query(
      `INSERT INTO budgets (id, organization_id, scope, scope_id, period, budget_limit, currency, action, warn_threshold, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET scope=EXCLUDED.scope, scope_id=EXCLUDED.scope_id, period=EXCLUDED.period,
         budget_limit=EXCLUDED.budget_limit, currency=EXCLUDED.currency, action=EXCLUDED.action,
         warn_threshold=EXCLUDED.warn_threshold, enabled=EXCLUDED.enabled`,
      [budget.id, budget.organizationId, budget.scope, budget.scopeId ?? null, budget.period, budget.limit, budget.currency, budget.action, budget.warnThreshold ?? null, budget.enabled],
    );
    return budget;
  }

  async listBudgets(organizationId: string): Promise<Budget[]> {
    const { rows } = await this.pool.query('SELECT * FROM budgets WHERE organization_id=$1', [organizationId]);
    return rows.map((r) => ({
      id: String(r['id']),
      organizationId: String(r['organization_id']),
      scope: r['scope'] as Budget['scope'],
      scopeId: (r['scope_id'] as string | null) ?? undefined,
      period: r['period'] as Budget['period'],
      limit: Number(r['budget_limit']),
      currency: String(r['currency']),
      action: r['action'] as Budget['action'],
      warnThreshold: r['warn_threshold'] === null ? undefined : Number(r['warn_threshold']),
      enabled: Boolean(r['enabled']),
    }));
  }

  async deleteBudget(organizationId: string, id: string): Promise<void> {
    await this.pool.query('DELETE FROM budgets WHERE organization_id=$1 AND id=$2', [organizationId, id]);
  }

  async upsertAlertRule(rule: AlertRule): Promise<AlertRule> {
    await this.pool.query(
      `INSERT INTO alerts (id, organization_id, name, metric, comparator, threshold, for_minutes, cooldown_minutes, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, metric=EXCLUDED.metric, comparator=EXCLUDED.comparator,
         threshold=EXCLUDED.threshold, for_minutes=EXCLUDED.for_minutes, cooldown_minutes=EXCLUDED.cooldown_minutes,
         enabled=EXCLUDED.enabled`,
      [rule.id, rule.organizationId, rule.name, rule.metric, rule.comparator, rule.threshold, rule.forMinutes, rule.cooldownMinutes, rule.enabled, rule.createdAt],
    );
    return rule;
  }

  async listAlertRules(organizationId: string): Promise<AlertRule[]> {
    const { rows } = await this.pool.query('SELECT * FROM alerts WHERE organization_id=$1', [organizationId]);
    return rows.map((r) => ({
      id: String(r['id']),
      organizationId: String(r['organization_id']),
      name: String(r['name']),
      metric: r['metric'] as AlertRule['metric'],
      comparator: r['comparator'] as AlertRule['comparator'],
      threshold: Number(r['threshold']),
      forMinutes: Number(r['for_minutes']),
      cooldownMinutes: Number(r['cooldown_minutes']),
      enabled: Boolean(r['enabled']),
      createdAt: isoOf(r['created_at']),
    }));
  }

  async recordAlertEvent(event: AlertEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_events (id, alert_id, organization_id, fired_at, resolved_at, observed_value, threshold, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event.id, event.alertId, event.organizationId, event.firedAt, event.resolvedAt ?? null, event.observedValue, event.threshold, event.message],
    );
  }

  async listAlertEvents(organizationId: string, limit = 100): Promise<AlertEvent[]> {
    const { rows } = await this.pool.query('SELECT * FROM alert_events WHERE organization_id=$1 ORDER BY fired_at DESC LIMIT $2', [organizationId, limit]);
    return rows.map(mapAlertEvent);
  }

  async lastAlertEvent(alertId: string): Promise<AlertEvent | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM alert_events WHERE alert_id=$1 ORDER BY fired_at DESC LIMIT 1', [alertId]);
    return rows[0] ? mapAlertEvent(rows[0]) : undefined;
  }

  async upsertWebhook(webhook: WebhookEndpoint): Promise<WebhookEndpoint> {
    await this.pool.query(
      `INSERT INTO webhooks (id, organization_id, url, secret_encrypted, events, enabled, consecutive_failures, last_delivery_at, last_delivery_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, secret_encrypted=EXCLUDED.secret_encrypted,
         events=EXCLUDED.events, enabled=EXCLUDED.enabled, consecutive_failures=EXCLUDED.consecutive_failures,
         last_delivery_at=EXCLUDED.last_delivery_at, last_delivery_status=EXCLUDED.last_delivery_status`,
      [webhook.id, webhook.organizationId, webhook.url, webhook.secretEncrypted, webhook.events, webhook.enabled, webhook.consecutiveFailures, webhook.lastDeliveryAt ?? null, webhook.lastDeliveryStatus ?? null, webhook.createdAt],
    );
    return webhook;
  }

  async listWebhooks(organizationId: string): Promise<WebhookEndpoint[]> {
    const { rows } = await this.pool.query('SELECT * FROM webhooks WHERE organization_id=$1', [organizationId]);
    return rows.map((r) => ({
      id: String(r['id']),
      organizationId: String(r['organization_id']),
      url: String(r['url']),
      secretEncrypted: String(r['secret_encrypted']),
      events: (r['events'] as WebhookEndpoint['events']) ?? [],
      enabled: Boolean(r['enabled']),
      consecutiveFailures: Number(r['consecutive_failures']),
      lastDeliveryAt: r['last_delivery_at'] ? isoOf(r['last_delivery_at']) : null,
      lastDeliveryStatus: (r['last_delivery_status'] as number | null) ?? null,
      createdAt: isoOf(r['created_at']),
    }));
  }

  async deleteWebhook(organizationId: string, id: string): Promise<void> {
    await this.pool.query('DELETE FROM webhooks WHERE organization_id=$1 AND id=$2', [organizationId, id]);
  }

  async enqueueDelivery(delivery: WebhookDelivery): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempts, status, last_error, next_attempt_at, delivered_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [delivery.id, delivery.webhookId, delivery.event, JSON.stringify(delivery.payload), delivery.attempts, delivery.status, delivery.lastError ?? null, delivery.nextAttemptAt ?? null, delivery.deliveredAt ?? null, delivery.createdAt],
    );
  }

  /**
   * SKIP LOCKED so several workers can drain the queue without delivering the
   * same webhook twice.
   */
  async claimPendingDeliveries(now: Date, limit: number): Promise<WebhookDelivery[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM webhook_deliveries
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit],
    );
    return rows.map((r) => ({
      id: String(r['id']),
      webhookId: String(r['webhook_id']),
      event: r['event'] as WebhookDelivery['event'],
      payload: r['payload'],
      attempts: Number(r['attempts']),
      status: r['status'] as WebhookDelivery['status'],
      lastError: (r['last_error'] as string | null) ?? null,
      nextAttemptAt: r['next_attempt_at'] ? isoOf(r['next_attempt_at']) : null,
      deliveredAt: r['delivered_at'] ? isoOf(r['delivered_at']) : null,
      createdAt: isoOf(r['created_at']),
    }));
  }

  async updateDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_deliveries SET
         attempts = COALESCE($2, attempts),
         status = COALESCE($3, status),
         last_error = COALESCE($4, last_error),
         next_attempt_at = COALESCE($5, next_attempt_at),
         delivered_at = COALESCE($6, delivered_at)
       WHERE id = $1`,
      [id, patch.attempts ?? null, patch.status ?? null, patch.lastError ?? null, patch.nextAttemptAt ?? null, patch.deliveredAt ?? null],
    );
  }

  // --- audit and health ----------------------------------------------

  async appendAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata, ip, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.id, entry.organizationId, entry.actorId, entry.actorType, entry.action, entry.resourceType, entry.resourceId, entry.metadata ? JSON.stringify(entry.metadata) : null, entry.ip ?? null, entry.createdAt],
    );
  }

  async listAuditLog(organizationId: string, limit = 100): Promise<AuditLogEntry[]> {
    const { rows } = await this.pool.query('SELECT * FROM audit_logs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2', [organizationId, limit]);
    return rows.map((r) => ({
      id: String(r['id']),
      organizationId: String(r['organization_id']),
      actorId: String(r['actor_id']),
      actorType: r['actor_type'] as AuditLogEntry['actorType'],
      action: String(r['action']),
      resourceType: String(r['resource_type']),
      resourceId: String(r['resource_id']),
      metadata: (r['metadata'] as Record<string, unknown> | null) ?? undefined,
      ip: (r['ip'] as string | null) ?? null,
      createdAt: isoOf(r['created_at']),
    }));
  }

  async recordHealthSnapshot(snapshot: ProviderHealthSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_health_snapshots (id, provider_id, state, latency_ms, success_rate, p95_latency_ms, sample_count, message, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [snapshot.id, snapshot.providerId, snapshot.state, snapshot.latencyMs ?? null, snapshot.successRate, snapshot.p95LatencyMs, snapshot.sampleCount, snapshot.message ?? null, snapshot.checkedAt],
    );
  }

  async listHealthSnapshots(providerId?: string, limit = 100): Promise<ProviderHealthSnapshot[]> {
    const { rows } = providerId
      ? await this.pool.query('SELECT * FROM provider_health_snapshots WHERE provider_id=$1 ORDER BY checked_at DESC LIMIT $2', [providerId, limit])
      : await this.pool.query('SELECT * FROM provider_health_snapshots ORDER BY checked_at DESC LIMIT $1', [limit]);
    return rows.map((r) => ({
      id: String(r['id']),
      providerId: String(r['provider_id']),
      state: r['state'] as ProviderHealthSnapshot['state'],
      latencyMs: (r['latency_ms'] as number | null) ?? undefined,
      successRate: Number(r['success_rate']),
      p95LatencyMs: Number(r['p95_latency_ms']),
      sampleCount: Number(r['sample_count']),
      message: (r['message'] as string | null) ?? undefined,
      checkedAt: Number(r['checked_at']),
    }));
  }
}

// ----------------------------------------------------------- row mappers

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(Number(value)).toISOString();
}

function mapOrganization(r: Record<string, unknown>): Organization {
  return {
    id: String(r['id']),
    name: String(r['name']),
    slug: String(r['slug']),
    currency: String(r['currency']),
    privacy: r['privacy'] as Organization['privacy'],
    allowedModels: (r['allowed_models'] as string[] | null) ?? null,
    deniedModels: (r['denied_models'] as string[]) ?? [],
    createdAt: isoOf(r['created_at']),
  };
}

function mapProject(r: Record<string, unknown>): Project {
  return {
    id: String(r['id']),
    organizationId: String(r['organization_id']),
    name: String(r['name']),
    slug: String(r['slug']),
    allowedModels: (r['allowed_models'] as string[] | null) ?? null,
    deniedModels: (r['denied_models'] as string[]) ?? [],
    routingPolicyId: (r['routing_policy_id'] as string | null) ?? null,
    privacy: (r['privacy'] as Project['privacy']) ?? null,
    archived: Boolean(r['archived']),
    createdAt: isoOf(r['created_at']),
  };
}

function mapApiKey(r: Record<string, unknown>): ApiKeyLookup {
  return {
    id: String(r['id']),
    organizationId: String(r['organization_id']),
    projectId: String(r['project_id']),
    name: String(r['name']),
    prefix: String(r['prefix']),
    hash: String(r['hash']),
    lookupIndex: String(r['lookup_index']),
    scopes: (r['scopes'] as ApiKeyScope[]) ?? [],
    createdBy: (r['created_by'] as string | null) ?? undefined,
    rotatedFrom: (r['rotated_from'] as string | null) ?? null,
    lastUsedAt: r['last_used_at'] ? isoOf(r['last_used_at']) : null,
    expiresAt: r['expires_at'] ? isoOf(r['expires_at']) : null,
    revokedAt: r['revoked_at'] ? isoOf(r['revoked_at']) : null,
    createdAt: isoOf(r['created_at']),
  };
}

function mapProvider(r: Record<string, unknown>): ProviderConfig {
  return {
    id: String(r['id']),
    kind: String(r['kind']),
    displayName: String(r['display_name']),
    baseUrl: (r['base_url'] as string | null) ?? undefined,
    credential: r['credential_ref'] ? { ref: String(r['credential_ref']) } : undefined,
    headers: (r['headers'] as Record<string, string> | null) ?? undefined,
    timeoutMs: (r['timeout_ms'] as number | null) ?? undefined,
    weight: r['weight'] === null ? undefined : Number(r['weight']),
    priority: (r['priority'] as number | null) ?? undefined,
    enabled: Boolean(r['enabled']),
  };
}

function mapModel(r: Record<string, unknown>): ModelDescriptor {
  return {
    id: String(r['id']),
    providerId: String(r['provider_id']),
    providerModelId: String(r['provider_model_id']),
    displayName: String(r['display_name']),
    contextWindow: Number(r['context_window']),
    maxOutputTokens: (r['max_output_tokens'] as number | null) ?? undefined,
    capabilities: (r['capabilities'] as ModelDescriptor['capabilities']) ?? [],
    status: r['status'] as ModelDescriptor['status'],
    family: (r['family'] as string | null) ?? undefined,
    description: (r['description'] as string | null) ?? undefined,
    deprecatedAt: r['deprecated_at'] ? isoOf(r['deprecated_at']) : null,
  };
}

function mapPolicy(r: Record<string, unknown>): StoredPolicyRow {
  return {
    id: String(r['id']),
    organizationId: String(r['organization_id']),
    projectId: (r['project_id'] as string | null) ?? null,
    name: String(r['name']),
    activeVersion: Number(r['active_version']),
    createdAt: isoOf(r['created_at']),
    updatedAt: isoOf(r['updated_at']),
  };
}

function mapPolicyVersion(r: Record<string, unknown>): PolicyVersionRow {
  return {
    id: String(r['id']),
    policyId: String(r['policy_id']),
    version: Number(r['version']),
    document: r['document'],
    checksum: String(r['checksum']),
    createdBy: String(r['created_by']),
    note: (r['note'] as string | null) ?? null,
    active: Boolean(r['active']),
    createdAt: isoOf(r['created_at']),
  };
}

function mapRequest(r: Record<string, unknown>): RequestRecord {
  const usageSource = r['usage_source'] as RequestRecord['usageSource'];
  const total = r['total_tokens'] as number | null;
  return {
    id: String(r['id']),
    organizationId: String(r['organization_id']),
    projectId: String(r['project_id']),
    apiKeyId: String(r['api_key_id']),
    createdAt: isoOf(r['created_at']),
    endpoint: r['endpoint'] as RequestRecord['endpoint'],
    requestedModel: String(r['requested_model']),
    resolvedProviderId: (r['resolved_provider_id'] as string | null) ?? undefined,
    resolvedModelId: (r['resolved_model_id'] as string | null) ?? undefined,
    strategy: (r['strategy'] as string | null) ?? undefined,
    status: r['status'] as RequestRecord['status'],
    errorType: (r['error_type'] as RequestRecord['errorType']) ?? undefined,
    errorMessage: (r['error_message'] as string | null) ?? undefined,
    httpStatus: Number(r['http_status']),
    streamed: Boolean(r['streamed']),
    latencyMs: Number(r['latency_ms']),
    timeToFirstTokenMs: (r['time_to_first_token_ms'] as number | null) ?? undefined,
    cacheStatus: r['cache_status'] as RequestRecord['cacheStatus'],
    cacheSimilarity: r['cache_similarity'] === null ? undefined : Number(r['cache_similarity']),
    fallbackUsed: Boolean(r['fallback_used']),
    attemptCount: Number(r['attempt_count']),
    usage:
      total === null || usageSource === undefined
        ? undefined
        : {
            input: Number(r['input_tokens'] ?? 0),
            output: Number(r['output_tokens'] ?? 0),
            total: Number(total),
            cachedInput: r['cached_input_tokens'] === null ? undefined : Number(r['cached_input_tokens']),
            source: usageSource,
          },
    usageSource,
    estimatedCost: r['estimated_cost'] === null ? undefined : Number(r['estimated_cost']),
    currency: (r['currency'] as string | null) ?? undefined,
    pricingVersion: (r['pricing_version'] as string | null) ?? undefined,
    isTest: Boolean(r['is_test']),
    tags: (r['tags'] as string[]) ?? [],
    routingReasons: (r['routing_reasons'] as string[] | null) ?? undefined,
    promptRef: (r['prompt_ref'] as string | null) ?? null,
    userAgent: (r['user_agent'] as string | null) ?? undefined,
  };
}

function mapAttempt(r: Record<string, unknown>): RequestAttempt {
  const source = r['usage_source'] as RequestAttempt['usage'] extends infer U ? (U extends { source: infer S } ? S : never) : never;
  const input = r['input_tokens'] as number | null;
  return {
    id: String(r['id']),
    requestId: String(r['request_id']),
    attemptNumber: Number(r['attempt_number']),
    providerId: String(r['provider_id']),
    modelId: String(r['model_id']),
    startedAt: Number(r['started_at']),
    durationMs: Number(r['duration_ms']),
    status: r['status'] as RequestAttempt['status'],
    errorType: (r['error_type'] as RequestAttempt['errorType']) ?? undefined,
    errorMessage: (r['error_message'] as string | null) ?? undefined,
    providerStatus: (r['provider_status'] as number | null) ?? undefined,
    httpRetryAfterSeconds: (r['retry_after_seconds'] as number | null) ?? undefined,
    timeToFirstTokenMs: (r['time_to_first_token_ms'] as number | null) ?? undefined,
    backoffMs: (r['backoff_ms'] as number | null) ?? undefined,
    usage:
      input === null || !source
        ? undefined
        : {
            input: Number(input),
            output: Number(r['output_tokens'] ?? 0),
            total: Number(input) + Number(r['output_tokens'] ?? 0),
            source,
          },
  };
}

function mapStep(r: Record<string, unknown>): TraceStep {
  return {
    name: r['name'] as TraceStep['name'],
    status: r['status'] as TraceStep['status'],
    startedAt: Number(r['started_at']),
    durationMs: Number(r['duration_ms']),
    errorType: (r['error_type'] as TraceStep['errorType']) ?? undefined,
    message: (r['message'] as string | null) ?? undefined,
    detail: (r['detail'] as Record<string, unknown> | null) ?? undefined,
  };
}

function mapAlertEvent(r: Record<string, unknown>): AlertEvent {
  return {
    id: String(r['id']),
    alertId: String(r['alert_id']),
    organizationId: String(r['organization_id']),
    firedAt: isoOf(r['fired_at']),
    resolvedAt: r['resolved_at'] ? isoOf(r['resolved_at']) : null,
    observedValue: Number(r['observed_value']),
    threshold: Number(r['threshold']),
    message: String(r['message']),
  };
}
