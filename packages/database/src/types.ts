import type {
  ApiKeyRecord,
  ApiKeyScope,
  ModelDescriptor,
  Organization,
  OrganizationMember,
  Project,
  ProviderConfig,
  ProviderHealth,
  RequestAttempt,
  RequestRecord,
  RequestStatus,
  TraceStep,
} from '@ai-gateway/core';
import type { Budget } from '@ai-gateway/usage';
import type { PricingSnapshot } from '@ai-gateway/pricing';

export interface StoredPolicyRow {
  id: string;
  organizationId: string;
  projectId: string | null;
  name: string;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyVersionRow {
  id: string;
  policyId: string;
  version: number;
  /** Serialized policy document. */
  document: unknown;
  checksum: string;
  createdAt: string;
  createdBy: string;
  note?: string | null;
  active: boolean;
}

export interface ApiKeyLookup extends ApiKeyRecord {
  /** Peppered HMAC used for the O(1) lookup path. */
  lookupIndex: string;
}

export interface WebhookEndpoint {
  id: string;
  organizationId: string;
  url: string;
  /** Encrypted at rest; decrypted only when signing a delivery. */
  secretEncrypted: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: number | null;
  consecutiveFailures: number;
}

export type WebhookEventType =
  | 'budget.warning'
  | 'budget.exceeded'
  | 'provider.degraded'
  | 'provider.recovered'
  | 'high_error_rate'
  | 'circuit.opened'
  | 'circuit.closed';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  payload: unknown;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string | null;
  nextAttemptAt?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
}

export interface AlertRule {
  id: string;
  organizationId: string;
  name: string;
  metric: 'error_rate' | 'p95_latency_ms' | 'monthly_cost' | 'provider_unavailable' | 'fallback_rate';
  comparator: 'gt' | 'lt';
  threshold: number;
  /** Minutes the condition must hold before firing, to suppress spikes. */
  forMinutes: number;
  /** Minimum minutes between repeat notifications for the same rule. */
  cooldownMinutes: number;
  enabled: boolean;
  createdAt: string;
}

export interface AlertEvent {
  id: string;
  alertId: string;
  organizationId: string;
  firedAt: string;
  resolvedAt?: string | null;
  observedValue: number;
  threshold: number;
  message: string;
}

export interface AuditLogEntry {
  id: string;
  organizationId: string;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType: string;
  resourceId: string;
  /** Redacted before it gets here. Never contains secrets. */
  metadata?: Record<string, unknown>;
  createdAt: string;
  ip?: string | null;
}

export interface ProviderHealthSnapshot extends ProviderHealth {
  id: string;
  successRate: number;
  p95LatencyMs: number;
  sampleCount: number;
}

export interface RequestQuery {
  organizationId: string;
  projectId?: string;
  apiKeyId?: string;
  providerId?: string;
  modelId?: string;
  status?: RequestStatus;
  from?: Date;
  to?: Date;
  /** Include playground and simulation traffic. Off by default. */
  includeTest?: boolean;
  search?: string;
  limit?: number;
  /** Request id to page from, exclusive. IDs sort by creation time. */
  cursor?: string;
}

export interface StoredPromptBody {
  requestId: string;
  organizationId: string;
  /** Already redacted or omitted according to the org's retention mode. */
  request?: unknown;
  response?: unknown;
  storedAt: string;
  expiresAt: string;
}

/**
 * Persistence contract.
 *
 * Two implementations ship: an in-memory store so `pnpm dev` and the test
 * suite need no database, and PostgreSQL for real deployments. Nothing above
 * this interface knows which one it is talking to.
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';

  // --- tenancy -------------------------------------------------------
  createOrganization(org: Organization): Promise<Organization>;
  getOrganization(id: string): Promise<Organization | undefined>;
  getOrganizationBySlug(slug: string): Promise<Organization | undefined>;
  updateOrganization(id: string, patch: Partial<Organization>): Promise<Organization>;
  listOrganizations(): Promise<Organization[]>;

  addMember(member: OrganizationMember): Promise<OrganizationMember>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  getMembership(organizationId: string, userId: string): Promise<OrganizationMember | undefined>;

  createProject(project: Project): Promise<Project>;
  getProject(id: string): Promise<Project | undefined>;
  listProjects(organizationId: string): Promise<Project[]>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;

  // --- api keys ------------------------------------------------------
  createApiKey(key: ApiKeyLookup): Promise<ApiKeyRecord>;
  /** Single indexed read; never a scan over every key. */
  findApiKeyByIndex(lookupIndex: string): Promise<ApiKeyLookup | undefined>;
  getApiKey(id: string): Promise<ApiKeyRecord | undefined>;
  listApiKeys(organizationId: string, projectId?: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(id: string, at: string): Promise<void>;
  touchApiKey(id: string, at: string): Promise<void>;
  updateApiKeyScopes(id: string, scopes: ApiKeyScope[]): Promise<void>;

  // --- providers and models -----------------------------------------
  upsertProvider(organizationId: string, config: ProviderConfig): Promise<ProviderConfig>;
  listProviders(organizationId: string): Promise<ProviderConfig[]>;
  getProvider(organizationId: string, id: string): Promise<ProviderConfig | undefined>;
  deleteProvider(organizationId: string, id: string): Promise<void>;
  /** Encrypted blob; the store never sees plaintext. */
  putProviderCredential(organizationId: string, ref: string, encrypted: string): Promise<void>;
  getProviderCredential(organizationId: string, ref: string): Promise<string | undefined>;
  listProviderCredentialRefs(organizationId: string): Promise<string[]>;

  upsertModel(organizationId: string, model: ModelDescriptor): Promise<ModelDescriptor>;
  listModels(organizationId: string): Promise<ModelDescriptor[]>;
  deleteModel(organizationId: string, modelId: string): Promise<void>;

  publishPricing(organizationId: string, snapshot: PricingSnapshot): Promise<void>;
  listPricingSnapshots(organizationId: string): Promise<PricingSnapshot[]>;

  // --- policies ------------------------------------------------------
  createPolicy(row: StoredPolicyRow, version: PolicyVersionRow): Promise<void>;
  addPolicyVersion(version: PolicyVersionRow): Promise<void>;
  activatePolicyVersion(policyId: string, version: number, at: string): Promise<void>;
  getPolicy(id: string): Promise<StoredPolicyRow | undefined>;
  listPolicies(organizationId: string, projectId?: string): Promise<StoredPolicyRow[]>;
  getActivePolicyVersion(policyId: string): Promise<PolicyVersionRow | undefined>;
  listPolicyVersions(policyId: string): Promise<PolicyVersionRow[]>;

  // --- requests and traces -------------------------------------------
  recordRequest(record: RequestRecord, steps: TraceStep[], attempts: RequestAttempt[]): Promise<void>;
  getRequest(organizationId: string, requestId: string): Promise<RequestRecord | undefined>;
  getRequestTrace(
    organizationId: string,
    requestId: string,
  ): Promise<{ request: RequestRecord; steps: TraceStep[]; attempts: RequestAttempt[] } | undefined>;
  queryRequests(query: RequestQuery): Promise<{ records: RequestRecord[]; nextCursor?: string }>;
  /** Delete request rows older than the cutoff. Returns rows removed. */
  pruneRequests(organizationId: string, olderThan: Date): Promise<number>;

  putPromptBody(body: StoredPromptBody): Promise<void>;
  getPromptBody(organizationId: string, requestId: string): Promise<StoredPromptBody | undefined>;
  /** Delete bodies past their retention window. Returns rows removed. */
  prunePromptBodies(now: Date): Promise<number>;

  // --- budgets, alerts, webhooks -------------------------------------
  upsertBudget(budget: Budget): Promise<Budget>;
  listBudgets(organizationId: string): Promise<Budget[]>;
  deleteBudget(organizationId: string, id: string): Promise<void>;

  upsertAlertRule(rule: AlertRule): Promise<AlertRule>;
  listAlertRules(organizationId: string): Promise<AlertRule[]>;
  recordAlertEvent(event: AlertEvent): Promise<void>;
  listAlertEvents(organizationId: string, limit?: number): Promise<AlertEvent[]>;
  lastAlertEvent(alertId: string): Promise<AlertEvent | undefined>;

  upsertWebhook(webhook: WebhookEndpoint): Promise<WebhookEndpoint>;
  listWebhooks(organizationId: string): Promise<WebhookEndpoint[]>;
  deleteWebhook(organizationId: string, id: string): Promise<void>;
  enqueueDelivery(delivery: WebhookDelivery): Promise<void>;
  claimPendingDeliveries(now: Date, limit: number): Promise<WebhookDelivery[]>;
  updateDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<void>;

  // --- audit and health ----------------------------------------------
  appendAuditLog(entry: AuditLogEntry): Promise<void>;
  listAuditLog(organizationId: string, limit?: number): Promise<AuditLogEntry[]>;
  recordHealthSnapshot(snapshot: ProviderHealthSnapshot): Promise<void>;
  listHealthSnapshots(providerId?: string, limit?: number): Promise<ProviderHealthSnapshot[]>;

  // --- lifecycle -----------------------------------------------------
  migrate(): Promise<void>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
