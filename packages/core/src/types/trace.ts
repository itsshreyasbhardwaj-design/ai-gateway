import type { GatewayErrorType } from '../errors.js';
import type { MeasuredUsage, UsageSource } from './chat.js';

export type RequestStatus = 'success' | 'error' | 'cancelled';

export type TraceStepName =
  | 'request_received'
  | 'authentication'
  | 'rate_limit'
  | 'policy_evaluation'
  | 'budget_check'
  | 'cache_lookup'
  | 'routing'
  | 'provider_request'
  | 'provider_response'
  | 'usage_extraction'
  | 'cache_write'
  | 'response_sent';

export type TraceStepStatus = 'ok' | 'skipped' | 'error';

export interface TraceStep {
  name: TraceStepName;
  status: TraceStepStatus;
  startedAt: number;
  durationMs: number;
  /** Non-sensitive detail, e.g. `{ strategy: "lowest_cost", candidates: 4 }`. */
  detail?: Record<string, unknown>;
  errorType?: GatewayErrorType;
  message?: string;
}

export interface RequestAttempt {
  id: string;
  requestId: string;
  attemptNumber: number;
  providerId: string;
  modelId: string;
  startedAt: number;
  durationMs: number;
  status: RequestStatus;
  errorType?: GatewayErrorType;
  errorMessage?: string;
  providerStatus?: number;
  httpRetryAfterSeconds?: number;
  /** Time from request dispatch to the first streamed byte. */
  timeToFirstTokenMs?: number;
  usage?: MeasuredUsage;
  /** Delay the retry policy waited before making this attempt. */
  backoffMs?: number;
}

export type CacheStatus = 'miss' | 'exact_hit' | 'semantic_hit' | 'disabled' | 'bypass';

export interface RequestRecord {
  id: string;
  organizationId: string;
  projectId: string;
  apiKeyId: string;
  createdAt: string;
  endpoint: '/v1/chat/completions' | '/v1/responses' | '/v1/embeddings';
  requestedModel: string;
  resolvedProviderId?: string;
  resolvedModelId?: string;
  strategy?: string;
  status: RequestStatus;
  errorType?: GatewayErrorType;
  errorMessage?: string;
  httpStatus: number;
  streamed: boolean;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  cacheStatus: CacheStatus;
  cacheSimilarity?: number;
  fallbackUsed: boolean;
  attemptCount: number;
  usage?: MeasuredUsage;
  usageSource?: UsageSource;
  estimatedCost?: number;
  currency?: string;
  pricingVersion?: string;
  /** Playground and failover-test traffic, excluded from production analytics. */
  isTest: boolean;
  tags?: string[];
  routingReasons?: string[];
  /** Present only when the org's retention policy allows body storage. */
  promptRef?: string | null;
  userAgent?: string;
}

export interface RequestTrace {
  request: RequestRecord;
  steps: TraceStep[];
  attempts: RequestAttempt[];
}
