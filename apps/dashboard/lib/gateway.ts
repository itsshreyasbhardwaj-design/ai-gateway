import { getSession, type DashboardSession } from './session';

export interface GatewayFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Seconds to cache. 0 disables caching, which is the default for live data. */
  revalidate?: number;
  session?: DashboardSession;
}

export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'GatewayRequestError';
  }
}

export class NotConnectedError extends Error {
  constructor() {
    super('No gateway credential is configured for this dashboard.');
    this.name = 'NotConnectedError';
  }
}

/**
 * Server-side call into the gateway admin API.
 *
 * Runs only on the server: the admin key lives in an httpOnly cookie and is
 * never shipped to the browser, so no client component ever holds a credential
 * that could route inference or mint keys.
 */
export async function gatewayFetch<T>(path: string, options: GatewayFetchOptions = {}): Promise<T> {
  const session = options.session ?? (await getSession());
  if (!session) throw new NotConnectedError();

  const response = await fetch(`${session.gatewayUrl.replace(/\/+$/, '')}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // Operational data is live by default; a stale dashboard is worse than a
    // slightly slower one.
    cache: options.revalidate ? 'force-cache' : 'no-store',
    ...(options.revalidate ? { next: { revalidate: options.revalidate } } : {}),
  }).catch((err: Error) => {
    throw new GatewayRequestError(
      0,
      'connection_failed',
      `Could not reach the gateway at ${session.gatewayUrl}: ${err.message}`,
    );
  });

  const requestId = response.headers.get('x-request-id') ?? undefined;

  if (!response.ok) {
    let type = 'internal_error';
    let message = `Gateway returned HTTP ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { type?: string; message?: string } };
      if (body.error?.type) type = body.error.type;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* keep the generic message */
    }
    throw new GatewayRequestError(response.status, type, message, requestId);
  }

  return (await response.json()) as T;
}

/** Unauthenticated gateway endpoints, used by the connect page and the header. */
export async function gatewayPublicFetch<T>(gatewayUrl: string, path: string): Promise<T> {
  const response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new GatewayRequestError(response.status, 'unavailable', `HTTP ${response.status}`);
  return (await response.json()) as T;
}

// ------------------------------------------------------------------ types

export interface GatewayInfo {
  service: string;
  version: string;
  providers: string[];
  models: number;
  store: string;
  countersDurable: boolean;
  capabilities: Record<string, boolean>;
  pricing: { version: string; ageDays: number; verified: boolean; note?: string };
}

export interface ProviderRow {
  id: string;
  kind: string;
  displayName: string;
  baseUrl?: string;
  enabled: boolean;
  registered: boolean;
  models: number;
  credential: { ref: string; configured: boolean } | null;
  health: {
    state: string;
    total: number;
    successRate: number;
    errorRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    timeoutRate: number;
    rateLimitRate: number;
    windowMs: number;
  };
}

export interface ModelRow {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens?: number;
  capabilities: string[];
  status: string;
  family?: string;
  circuit: string;
  healthState: string;
  pricing: {
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
    cachedInputPerMillionTokens?: number;
    currency: string;
    pricingVersion: string;
    source: string;
    effectiveFrom: string;
    verified: boolean;
  } | null;
  measured: {
    requests: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    successRate: number;
    windowHours: number;
  } | null;
}

export interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  currency: string;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgTimeToFirstTokenMs: number | null;
  cacheHitRate: number;
  fallbackRate: number;
  estimatedUsageShare: number;
  pricingVersions: string[];
}

export interface UsageReport {
  range: { from: string; to: string; bucketMs: number };
  includeTest: boolean;
  summary: UsageSummary;
  series: Array<{
    bucket: string;
    requests: number;
    errors: number;
    tokens: number;
    cost: number;
    avgLatencyMs: number;
    cacheHits: number;
  }>;
  breakdown: {
    provider: GroupRow[];
    model: GroupRow[];
    status: GroupRow[];
    errorType: GroupRow[];
    apiKey?: GroupRow[];
  };
  disclosure: { pricingVersion: string; pricingAgeDays: number; estimatedUsageShare: number; note: string };
}

export interface GroupRow {
  key: string;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
}

export interface RequestRow {
  id: string;
  createdAt: string;
  projectId: string;
  apiKeyId: string;
  endpoint: string;
  requestedModel: string;
  resolvedProviderId?: string;
  resolvedModelId?: string;
  strategy?: string;
  status: 'success' | 'error' | 'cancelled';
  errorType?: string;
  errorMessage?: string;
  httpStatus: number;
  streamed: boolean;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  cacheStatus: string;
  cacheSimilarity?: number;
  fallbackUsed: boolean;
  attemptCount: number;
  usage?: { input: number; output: number; total: number; source: string; cachedInput?: number };
  estimatedCost?: number;
  currency?: string;
  pricingVersion?: string;
  isTest: boolean;
  tags?: string[];
  routingReasons?: string[];
}

export interface TraceStepRow {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  startedAt: number;
  durationMs: number;
  errorType?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface AttemptRow {
  id: string;
  attemptNumber: number;
  providerId: string;
  modelId: string;
  startedAt: number;
  durationMs: number;
  status: string;
  errorType?: string;
  errorMessage?: string;
  providerStatus?: number;
  timeToFirstTokenMs?: number;
  backoffMs?: number;
  usage?: { input: number; output: number; source: string };
}

export interface RequestTraceResponse {
  request: RequestRow;
  steps: TraceStepRow[];
  attempts: AttemptRow[];
  body: { request?: unknown; response?: unknown; storedAt: string; expiresAt: string } | null;
  privacy: { mode?: string; retentionDays?: number; bodyStored: boolean; note: string };
}

export interface BudgetStateRow {
  budget: {
    id: string;
    scope: string;
    scopeId?: string;
    period: string;
    limit: number;
    currency: string;
    action: string;
    warnThreshold?: number;
    enabled: boolean;
  };
  spent: number;
  remaining: number;
  utilization: number;
  periodStart: string;
  periodEnd: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  allowedModels?: string[] | null;
  deniedModels?: string[];
  routingPolicyId?: string | null;
  archived?: boolean;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  projectId: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  rotatedFrom?: string | null;
  status: 'active' | 'revoked' | 'expired';
  secretPreview: string;
}

export interface PolicyRow {
  id: string;
  name: string;
  projectId: string | null;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
  activeVersionDetail?: {
    version: number;
    document: Record<string, unknown>;
    checksum: string;
    createdBy: string;
    createdAt: string;
    note?: string | null;
  };
}

export interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  consecutiveFailures: number;
  lastDeliveryAt?: string | null;
  lastDeliveryStatus?: number | null;
  createdAt: string;
  secretConfigured: boolean;
}

export interface AlertRuleRow {
  id: string;
  name: string;
  metric: string;
  comparator: 'gt' | 'lt';
  threshold: number;
  forMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  createdAt: string;
}

export interface AlertEventRow {
  id: string;
  alertId: string;
  firedAt: string;
  resolvedAt?: string | null;
  observedValue: number;
  threshold: number;
  message: string;
}

export interface ProviderComparisonRow {
  providerId: string;
  requests: number;
  successRate: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  totalTokens: number;
  estimatedCost: number;
  costPerMillionTokens: number | null;
  measuredFrom: string;
  measuredTo: string;
  usageSourceMix: { provider_reported: number; estimated: number };
}

export interface RouteTestResponse {
  simulated: true;
  note: string;
  strategy: string;
  requiredCapabilities: string[];
  estimatedInputTokens: number;
  estimateIsApproximate: boolean;
  selected: { provider: string; model: string; score: number; reasons: string[] } | null;
  chain: Array<{
    position: number;
    role: string;
    provider: string;
    model: string;
    score: number;
    reasons: string[];
    signals: Record<string, unknown>;
  }>;
  rejected: Array<{ target: string; reason: string }>;
  planReasons: string[];
  policy: { name: string; version: number | null };
}
