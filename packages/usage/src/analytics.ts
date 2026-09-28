import type { RequestRecord, UsageSource } from '@ai-gateway/core';

export type TimeRange = '1h' | '24h' | '7d' | '30d' | '90d' | 'custom';

export interface RangeBounds {
  from: Date;
  to: Date;
  /** Bucket width in ms, chosen to keep every range near ~60 points. */
  bucketMs: number;
}

const RANGE_MS: Record<Exclude<TimeRange, 'custom'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  '90d': 7_776_000_000,
};

export function resolveRange(range: TimeRange, from?: Date, to?: Date, now = new Date()): RangeBounds {
  if (range === 'custom') {
    const end = to ?? now;
    const start = from ?? new Date(end.getTime() - RANGE_MS['24h']);
    return { from: start, to: end, bucketMs: bucketFor(end.getTime() - start.getTime()) };
  }
  const span = RANGE_MS[range];
  return { from: new Date(now.getTime() - span), to: now, bucketMs: bucketFor(span) };
}

function bucketFor(spanMs: number): number {
  const target = spanMs / 60;
  const candidates = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];
  return candidates.find((c) => c >= target) ?? 86_400_000;
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
  /**
   * Share of requests whose token counts were estimated rather than reported.
   * Surfaced next to the cost figure so nobody mistakes an estimate for a bill.
   */
  estimatedUsageShare: number;
  pricingVersions: string[];
}

export interface TimeSeriesPoint {
  bucket: string;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
  avgLatencyMs: number;
  cacheHits: number;
}

export interface GroupedUsage {
  key: string;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
}

/**
 * Aggregate request records.
 *
 * Test traffic (playground calls, failover simulations) is excluded by default:
 * mixing it into production analytics is exactly the kind of quiet data
 * corruption the spec prohibits.
 */
export function summarize(records: RequestRecord[], opts: { includeTest?: boolean; currency?: string } = {}): UsageSummary {
  const rows = opts.includeTest ? records : records.filter((r) => !r.isTest);
  const total = rows.length;
  const successes = rows.filter((r) => r.status === 'success');
  const failures = rows.filter((r) => r.status === 'error');
  const cancelled = rows.filter((r) => r.status === 'cancelled');

  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const ttfts = rows.map((r) => r.timeToFirstTokenMs).filter((v): v is number => typeof v === 'number');
  const cacheHits = rows.filter((r) => r.cacheStatus === 'exact_hit' || r.cacheStatus === 'semantic_hit');
  const estimated = rows.filter((r) => r.usage?.source === 'estimated');

  const inputTokens = sum(rows.map((r) => r.usage?.input ?? 0));
  const outputTokens = sum(rows.map((r) => r.usage?.output ?? 0));

  return {
    totalRequests: total,
    successfulRequests: successes.length,
    failedRequests: failures.length,
    cancelledRequests: cancelled.length,
    successRate: total ? successes.length / total : 0,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCost: round(sum(rows.map((r) => r.estimatedCost ?? 0))),
    currency: opts.currency ?? rows.find((r) => r.currency)?.currency ?? 'USD',
    avgLatencyMs: avg(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    avgTimeToFirstTokenMs: ttfts.length ? avg(ttfts) : null,
    cacheHitRate: total ? cacheHits.length / total : 0,
    fallbackRate: total ? rows.filter((r) => r.fallbackUsed).length / total : 0,
    estimatedUsageShare: total ? estimated.length / total : 0,
    pricingVersions: [...new Set(rows.map((r) => r.pricingVersion).filter((v): v is string => !!v))].sort(),
  };
}

export function timeSeries(
  records: RequestRecord[],
  bounds: RangeBounds,
  opts: { includeTest?: boolean } = {},
): TimeSeriesPoint[] {
  const rows = opts.includeTest ? records : records.filter((r) => !r.isTest);
  const buckets = new Map<number, RequestRecord[]>();

  const startMs = Math.floor(bounds.from.getTime() / bounds.bucketMs) * bounds.bucketMs;
  for (let t = startMs; t <= bounds.to.getTime(); t += bounds.bucketMs) buckets.set(t, []);

  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at) || at < bounds.from.getTime() || at > bounds.to.getTime()) continue;
    const bucket = Math.floor(at / bounds.bucketMs) * bounds.bucketMs;
    const list = buckets.get(bucket);
    if (list) list.push(row);
    else buckets.set(bucket, [row]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, rows]) => ({
      bucket: new Date(bucket).toISOString(),
      requests: rows.length,
      errors: rows.filter((r) => r.status === 'error').length,
      tokens: sum(rows.map((r) => r.usage?.total ?? 0)),
      cost: round(sum(rows.map((r) => r.estimatedCost ?? 0))),
      avgLatencyMs: avg(rows.map((r) => r.latencyMs)),
      cacheHits: rows.filter((r) => r.cacheStatus === 'exact_hit' || r.cacheStatus === 'semantic_hit').length,
    }));
}

export type GroupDimension = 'provider' | 'model' | 'project' | 'apiKey' | 'status' | 'errorType';

export function groupBy(
  records: RequestRecord[],
  dimension: GroupDimension,
  opts: { includeTest?: boolean } = {},
): GroupedUsage[] {
  const rows = opts.includeTest ? records : records.filter((r) => !r.isTest);
  const groups = new Map<string, RequestRecord[]>();

  for (const row of rows) {
    const key = keyFor(row, dimension);
    if (key === undefined) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([key, rows]) => {
      const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
      return {
        key,
        requests: rows.length,
        errors: rows.filter((r) => r.status === 'error').length,
        tokens: sum(rows.map((r) => r.usage?.total ?? 0)),
        cost: round(sum(rows.map((r) => r.estimatedCost ?? 0))),
        avgLatencyMs: avg(latencies),
        p95LatencyMs: percentile(latencies, 0.95),
        successRate: rows.length ? rows.filter((r) => r.status === 'success').length / rows.length : 0,
      };
    })
    .sort((a, b) => b.requests - a.requests);
}

function keyFor(row: RequestRecord, dimension: GroupDimension): string | undefined {
  switch (dimension) {
    case 'provider':
      return row.resolvedProviderId ?? 'unrouted';
    case 'model':
      return row.resolvedModelId ?? row.requestedModel;
    case 'project':
      return row.projectId;
    case 'apiKey':
      return row.apiKeyId;
    case 'status':
      return row.status;
    case 'errorType':
      return row.errorType;
  }
}

/**
 * Factual provider comparison.
 *
 * Measurements only - latency, success rate, cost, token volume - over an
 * explicit time range. No composite "score", no ranking of model quality.
 */
export interface ProviderComparison {
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
  usageSourceMix: Record<UsageSource, number>;
}

export function compareProviders(
  records: RequestRecord[],
  bounds: RangeBounds,
  opts: { includeTest?: boolean } = {},
): ProviderComparison[] {
  const rows = (opts.includeTest ? records : records.filter((r) => !r.isTest)).filter((r) => {
    const at = Date.parse(r.createdAt);
    return !Number.isNaN(at) && at >= bounds.from.getTime() && at <= bounds.to.getTime();
  });

  const groups = new Map<string, RequestRecord[]>();
  for (const row of rows) {
    if (!row.resolvedProviderId) continue;
    const list = groups.get(row.resolvedProviderId) ?? [];
    list.push(row);
    groups.set(row.resolvedProviderId, list);
  }

  return [...groups.entries()]
    .map(([providerId, rows]) => {
      const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
      const tokens = sum(rows.map((r) => r.usage?.total ?? 0));
      const cost = round(sum(rows.map((r) => r.estimatedCost ?? 0)));
      const reported = rows.filter((r) => r.usage?.source === 'provider_reported').length;
      const estimated = rows.filter((r) => r.usage?.source === 'estimated').length;
      return {
        providerId,
        requests: rows.length,
        successRate: rows.filter((r) => r.status === 'success').length / rows.length,
        errorRate: rows.filter((r) => r.status === 'error').length / rows.length,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        p99LatencyMs: percentile(latencies, 0.99),
        totalTokens: tokens,
        estimatedCost: cost,
        costPerMillionTokens: tokens > 0 ? round((cost / tokens) * 1_000_000) : null,
        measuredFrom: bounds.from.toISOString(),
        measuredTo: bounds.to.toISOString(),
        usageSourceMix: { provider_reported: reported, estimated },
      };
    })
    .sort((a, b) => b.requests - a.requests);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function avg(values: number[]): number {
  return values.length ? Math.round((sum(values) / values.length) * 100) / 100 : 0;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
