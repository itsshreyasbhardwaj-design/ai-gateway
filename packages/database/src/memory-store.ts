import {
  GatewayError,
  ulidTime,
  type ApiKeyRecord,
  type ApiKeyScope,
  type ModelDescriptor,
  type Organization,
  type OrganizationMember,
  type Project,
  type ProviderConfig,
  type RequestAttempt,
  type RequestRecord,
  type TraceStep,
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

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;

/**
 * In-process store.
 *
 * This is what makes `pnpm dev` work with nothing installed but Node, and what
 * the test suite runs against. It implements the same contract as Postgres,
 * including the tenant scoping - every read takes an organization id and
 * filters on it, so a cross-tenant bug would fail here too rather than only in
 * production.
 *
 * It is bounded: `maxRequests` keeps a long-running dev server from growing
 * without limit.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private organizations = new Map<string, Organization>();
  private members: OrganizationMember[] = [];
  private projects = new Map<string, Project>();
  private apiKeys = new Map<string, ApiKeyLookup>();
  private apiKeysByIndex = new Map<string, string>();
  private providers = new Map<string, ProviderConfig>();
  private credentials = new Map<string, string>();
  private models = new Map<string, ModelDescriptor>();
  private pricing = new Map<string, PricingSnapshot[]>();
  private policies = new Map<string, StoredPolicyRow>();
  private policyVersions = new Map<string, PolicyVersionRow[]>();
  private requests: RequestRecord[] = [];
  private traces = new Map<string, { steps: TraceStep[]; attempts: RequestAttempt[] }>();
  private promptBodies = new Map<string, StoredPromptBody>();
  private budgets = new Map<string, Budget>();
  private alertRules = new Map<string, AlertRule>();
  private alertEvents: AlertEvent[] = [];
  private webhooks = new Map<string, WebhookEndpoint>();
  private deliveries = new Map<string, WebhookDelivery>();
  private auditLog: AuditLogEntry[] = [];
  private healthSnapshots: ProviderHealthSnapshot[] = [];

  constructor(private readonly maxRequests = 20_000) {}

  private scoped(organizationId: string, id: string): string {
    return `${organizationId}::${id}`;
  }

  // --- tenancy -------------------------------------------------------

  async createOrganization(org: Organization): Promise<Organization> {
    if (this.organizations.has(org.id)) throw new Error(`organization exists: ${org.id}`);
    this.organizations.set(org.id, { ...org });
    return org;
  }

  async getOrganization(id: string): Promise<Organization | undefined> {
    return this.organizations.get(id);
  }

  async getOrganizationBySlug(slug: string): Promise<Organization | undefined> {
    return [...this.organizations.values()].find((o) => o.slug === slug);
  }

  async updateOrganization(id: string, patch: Partial<Organization>): Promise<Organization> {
    const existing = this.organizations.get(id);
    if (!existing) throw new Error(`unknown organization: ${id}`);
    const updated = { ...existing, ...patch, id };
    this.organizations.set(id, updated);
    return updated;
  }

  async listOrganizations(): Promise<Organization[]> {
    return [...this.organizations.values()];
  }

  async addMember(member: OrganizationMember): Promise<OrganizationMember> {
    this.members = this.members.filter(
      (m) => !(m.organizationId === member.organizationId && m.userId === member.userId),
    );
    this.members.push(member);
    return member;
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return this.members.filter((m) => m.organizationId === organizationId);
  }

  async getMembership(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMember | undefined> {
    return this.members.find((m) => m.organizationId === organizationId && m.userId === userId);
  }

  async createProject(project: Project): Promise<Project> {
    this.projects.set(project.id, { ...project });
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async listProjects(organizationId: string): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.organizationId === organizationId);
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const existing = this.projects.get(id);
    if (!existing) throw new Error(`unknown project: ${id}`);
    const updated = { ...existing, ...patch, id };
    this.projects.set(id, updated);
    return updated;
  }

  // --- api keys ------------------------------------------------------

  async createApiKey(key: ApiKeyLookup): Promise<ApiKeyRecord> {
    this.apiKeys.set(key.id, { ...key });
    this.apiKeysByIndex.set(key.lookupIndex, key.id);
    return key;
  }

  async findApiKeyByIndex(lookupIndex: string): Promise<ApiKeyLookup | undefined> {
    const id = this.apiKeysByIndex.get(lookupIndex);
    return id ? this.apiKeys.get(id) : undefined;
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    return this.apiKeys.get(id);
  }

  async listApiKeys(organizationId: string, projectId?: string): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()]
      .filter(
        (k) => k.organizationId === organizationId && (!projectId || k.projectId === projectId),
      )
      .map(({ lookupIndex: _lookupIndex, ...rest }) => rest);
  }

  async revokeApiKey(id: string, at: string): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key) key.revokedAt = at;
  }

  async touchApiKey(id: string, at: string): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key) key.lastUsedAt = at;
  }

  async updateApiKeyScopes(id: string, scopes: ApiKeyScope[]): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key) key.scopes = scopes;
  }

  // --- providers and models -----------------------------------------

  async upsertProvider(organizationId: string, config: ProviderConfig): Promise<ProviderConfig> {
    this.providers.set(this.scoped(organizationId, config.id), { ...config });
    return config;
  }

  async listProviders(organizationId: string): Promise<ProviderConfig[]> {
    const prefix = `${organizationId}::`;
    return [...this.providers.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  async getProvider(organizationId: string, id: string): Promise<ProviderConfig | undefined> {
    return this.providers.get(this.scoped(organizationId, id));
  }

  async deleteProvider(organizationId: string, id: string): Promise<void> {
    this.providers.delete(this.scoped(organizationId, id));
  }

  async putProviderCredential(
    organizationId: string,
    ref: string,
    encrypted: string,
  ): Promise<void> {
    this.credentials.set(this.scoped(organizationId, ref), encrypted);
  }

  async getProviderCredential(organizationId: string, ref: string): Promise<string | undefined> {
    return this.credentials.get(this.scoped(organizationId, ref));
  }

  async listProviderCredentialRefs(organizationId: string): Promise<string[]> {
    const prefix = `${organizationId}::`;
    return [...this.credentials.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  async upsertModel(organizationId: string, model: ModelDescriptor): Promise<ModelDescriptor> {
    this.models.set(this.scoped(organizationId, model.id), { ...model });
    return model;
  }

  async listModels(organizationId: string): Promise<ModelDescriptor[]> {
    const prefix = `${organizationId}::`;
    return [...this.models.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  async deleteModel(organizationId: string, modelId: string): Promise<void> {
    this.models.delete(this.scoped(organizationId, modelId));
  }

  async publishPricing(organizationId: string, snapshot: PricingSnapshot): Promise<void> {
    const list = this.pricing.get(organizationId) ?? [];
    if (list.some((s) => s.version === snapshot.version)) {
      throw new GatewayError(
        'invalid_request',
        `Pricing version "${snapshot.version}" already exists.`,
      );
    }
    list.push(snapshot);
    this.pricing.set(organizationId, list);
  }

  async listPricingSnapshots(organizationId: string): Promise<PricingSnapshot[]> {
    return [...(this.pricing.get(organizationId) ?? [])];
  }

  // --- policies ------------------------------------------------------

  async createPolicy(row: StoredPolicyRow, version: PolicyVersionRow): Promise<void> {
    this.policies.set(row.id, { ...row });
    this.policyVersions.set(row.id, [{ ...version }]);
  }

  async addPolicyVersion(version: PolicyVersionRow): Promise<void> {
    const list = this.policyVersions.get(version.policyId);
    if (!list) throw new Error(`unknown policy: ${version.policyId}`);
    list.push({ ...version });
  }

  async activatePolicyVersion(policyId: string, version: number, at: string): Promise<void> {
    const list = this.policyVersions.get(policyId);
    const policy = this.policies.get(policyId);
    if (!list || !policy) throw new Error(`unknown policy: ${policyId}`);
    if (!list.some((v) => v.version === version)) throw new Error(`unknown version ${version}`);
    for (const v of list) v.active = v.version === version;
    policy.activeVersion = version;
    policy.updatedAt = at;
  }

  async getPolicy(id: string): Promise<StoredPolicyRow | undefined> {
    return this.policies.get(id);
  }

  async listPolicies(organizationId: string, projectId?: string): Promise<StoredPolicyRow[]> {
    return [...this.policies.values()].filter(
      (p) =>
        p.organizationId === organizationId &&
        (projectId === undefined || p.projectId === projectId),
    );
  }

  async getActivePolicyVersion(policyId: string): Promise<PolicyVersionRow | undefined> {
    return this.policyVersions.get(policyId)?.find((v) => v.active);
  }

  async listPolicyVersions(policyId: string): Promise<PolicyVersionRow[]> {
    return [...(this.policyVersions.get(policyId) ?? [])].sort((a, b) => a.version - b.version);
  }

  // --- requests ------------------------------------------------------

  async recordRequest(
    record: RequestRecord,
    steps: TraceStep[],
    attempts: RequestAttempt[],
  ): Promise<void> {
    this.requests.push({ ...record });
    this.traces.set(record.id, { steps: [...steps], attempts: [...attempts] });
    if (this.requests.length > this.maxRequests) {
      const dropped = this.requests.splice(0, this.requests.length - this.maxRequests);
      for (const row of dropped) this.traces.delete(row.id);
    }
  }

  async getRequest(organizationId: string, requestId: string): Promise<RequestRecord | undefined> {
    return this.requests.find((r) => r.id === requestId && r.organizationId === organizationId);
  }

  async getRequestTrace(organizationId: string, requestId: string) {
    const request = await this.getRequest(organizationId, requestId);
    if (!request) return undefined;
    const trace = this.traces.get(requestId) ?? { steps: [], attempts: [] };
    return { request, steps: trace.steps, attempts: trace.attempts };
  }

  async queryRequests(
    query: RequestQuery,
  ): Promise<{ records: RequestRecord[]; nextCursor?: string }> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const fromMs = query.from?.getTime();
    const toMs = query.to?.getTime();

    let rows = this.requests.filter((r) => {
      if (r.organizationId !== query.organizationId) return false;
      if (query.projectId && r.projectId !== query.projectId) return false;
      if (query.apiKeyId && r.apiKeyId !== query.apiKeyId) return false;
      if (query.providerId && r.resolvedProviderId !== query.providerId) return false;
      if (query.modelId && r.resolvedModelId !== query.modelId) return false;
      if (query.status && r.status !== query.status) return false;
      if (!query.includeTest && r.isTest) return false;
      const at = Date.parse(r.createdAt);
      if (fromMs !== undefined && at < fromMs) return false;
      if (toMs !== undefined && at > toMs) return false;
      if (query.search) {
        const needle = query.search.toLowerCase();
        const haystack = [r.id, r.requestedModel, r.resolvedModelId, r.errorType, ...(r.tags ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    // IDs are ULIDs, so lexicographic order is chronological order.
    rows.sort((a, b) => b.id.localeCompare(a.id));
    if (query.cursor) rows = rows.filter((r) => r.id.localeCompare(query.cursor!) < 0);

    const page = rows.slice(0, limit);
    return {
      records: page,
      nextCursor: rows.length > limit ? page.at(-1)?.id : undefined,
    };
  }

  async pruneRequests(organizationId: string, olderThan: Date): Promise<number> {
    const cutoff = olderThan.getTime();
    const before = this.requests.length;
    const keep: RequestRecord[] = [];
    for (const row of this.requests) {
      const at = row.id.startsWith('req_') ? ulidTime(row.id.slice(4)) : Date.parse(row.createdAt);
      if (row.organizationId === organizationId && at < cutoff) {
        this.traces.delete(row.id);
        continue;
      }
      keep.push(row);
    }
    this.requests = keep;
    return before - keep.length;
  }

  async putPromptBody(body: StoredPromptBody): Promise<void> {
    this.promptBodies.set(this.scoped(body.organizationId, body.requestId), { ...body });
  }

  async getPromptBody(
    organizationId: string,
    requestId: string,
  ): Promise<StoredPromptBody | undefined> {
    return this.promptBodies.get(this.scoped(organizationId, requestId));
  }

  async prunePromptBodies(now: Date): Promise<number> {
    let removed = 0;
    for (const [key, body] of this.promptBodies) {
      if (Date.parse(body.expiresAt) <= now.getTime()) {
        this.promptBodies.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // --- budgets, alerts, webhooks -------------------------------------

  async upsertBudget(budget: Budget): Promise<Budget> {
    this.budgets.set(budget.id, { ...budget });
    return budget;
  }

  async listBudgets(organizationId: string): Promise<Budget[]> {
    return [...this.budgets.values()].filter((b) => b.organizationId === organizationId);
  }

  async deleteBudget(organizationId: string, id: string): Promise<void> {
    const existing = this.budgets.get(id);
    if (existing?.organizationId === organizationId) this.budgets.delete(id);
  }

  async upsertAlertRule(rule: AlertRule): Promise<AlertRule> {
    this.alertRules.set(rule.id, { ...rule });
    return rule;
  }

  async listAlertRules(organizationId: string): Promise<AlertRule[]> {
    return [...this.alertRules.values()].filter((r) => r.organizationId === organizationId);
  }

  async recordAlertEvent(event: AlertEvent): Promise<void> {
    this.alertEvents.push({ ...event });
  }

  async listAlertEvents(organizationId: string, limit = 100): Promise<AlertEvent[]> {
    return this.alertEvents
      .filter((e) => e.organizationId === organizationId)
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      .slice(0, limit);
  }

  async lastAlertEvent(alertId: string): Promise<AlertEvent | undefined> {
    return this.alertEvents
      .filter((e) => e.alertId === alertId)
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0];
  }

  async upsertWebhook(webhook: WebhookEndpoint): Promise<WebhookEndpoint> {
    this.webhooks.set(webhook.id, { ...webhook });
    return webhook;
  }

  async listWebhooks(organizationId: string): Promise<WebhookEndpoint[]> {
    return [...this.webhooks.values()].filter((w) => w.organizationId === organizationId);
  }

  async deleteWebhook(organizationId: string, id: string): Promise<void> {
    const existing = this.webhooks.get(id);
    if (existing?.organizationId === organizationId) this.webhooks.delete(id);
  }

  async enqueueDelivery(delivery: WebhookDelivery): Promise<void> {
    this.deliveries.set(delivery.id, { ...delivery });
  }

  async claimPendingDeliveries(now: Date, limit: number): Promise<WebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (d) =>
          d.status === 'pending' &&
          (!d.nextAttemptAt || Date.parse(d.nextAttemptAt) <= now.getTime()),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async updateDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void> {
    const existing = this.deliveries.get(id);
    if (existing) this.deliveries.set(id, { ...existing, ...patch });
  }

  // --- audit and health ----------------------------------------------

  async appendAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLog.push({ ...entry });
  }

  async listAuditLog(organizationId: string, limit = 100): Promise<AuditLogEntry[]> {
    return this.auditLog
      .filter((e) => e.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async recordHealthSnapshot(snapshot: ProviderHealthSnapshot): Promise<void> {
    this.healthSnapshots.push({ ...snapshot });
    if (this.healthSnapshots.length > 10_000) this.healthSnapshots.splice(0, 5_000);
  }

  async listHealthSnapshots(providerId?: string, limit = 100): Promise<ProviderHealthSnapshot[]> {
    return this.healthSnapshots
      .filter((s) => !providerId || s.providerId === providerId)
      .sort((a, b) => b.checkedAt - a.checkedAt)
      .slice(0, limit);
  }

  // --- lifecycle -----------------------------------------------------

  async migrate(): Promise<void> {
    /* nothing to migrate */
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  /** Test helper. */
  get requestCount(): number {
    return this.requests.length;
  }
}
