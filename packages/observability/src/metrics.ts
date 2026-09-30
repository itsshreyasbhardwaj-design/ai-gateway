/**
 * Minimal metrics registry with a Prometheus text exposition.
 *
 * Deliberately dependency-free: a gateway's own telemetry should not be the
 * thing that pulls a heavyweight client library into the hot path. Anything
 * richer is a scrape away.
 */

export type Labels = Record<string, string>;

interface Series {
  labels: Labels;
  value: number;
}

interface HistogramSeries {
  labels: Labels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

/** Latency buckets in ms, chosen for LLM traffic rather than web traffic. */
export const LATENCY_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000,
];

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

export class MetricsRegistry {
  private counters = new Map<string, Map<string, Series>>();
  private gauges = new Map<string, Map<string, Series>>();
  private histograms = new Map<string, Map<string, HistogramSeries>>();
  private help = new Map<string, string>();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, Series>();
    const key = labelKey(labels);
    const existing = series.get(key);
    if (existing) existing.value += by;
    else series.set(key, { labels, value: by });
    this.counters.set(name, series);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    const series = this.gauges.get(name) ?? new Map<string, Series>();
    series.set(labelKey(labels), { labels, value });
    this.gauges.set(name, series);
  }

  observe(name: string, value: number, labels: Labels = {}, buckets = LATENCY_BUCKETS_MS): void {
    const series = this.histograms.get(name) ?? new Map<string, HistogramSeries>();
    const key = labelKey(labels);
    let hist = series.get(key);
    if (!hist) {
      hist = {
        labels,
        buckets,
        counts: new Array<number>(buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      series.set(key, hist);
    }
    hist.sum += value;
    hist.count += 1;
    for (let i = 0; i < hist.buckets.length; i++) {
      if (value <= (hist.buckets[i] ?? Infinity)) {
        hist.counts[i] = (hist.counts[i] ?? 0) + 1;
      }
    }
    this.histograms.set(name, series);
  }

  getCounter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels))?.value ?? 0;
  }

  getGauge(name: string, labels: Labels = {}): number | undefined {
    return this.gauges.get(name)?.get(labelKey(labels))?.value;
  }

  getHistogram(name: string, labels: Labels = {}): { count: number; sum: number } | undefined {
    const hist = this.histograms.get(name)?.get(labelKey(labels));
    return hist ? { count: hist.count, sum: hist.sum } : undefined;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    const emitHelp = (name: string, type: string) => {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    for (const [name, series] of this.counters) {
      emitHelp(name, 'counter');
      for (const s of series.values()) lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const [name, series] of this.gauges) {
      emitHelp(name, 'gauge');
      for (const s of series.values()) lines.push(`${name}${renderLabels(s.labels)} ${s.value}`);
    }
    for (const [name, series] of this.histograms) {
      emitHelp(name, 'histogram');
      for (const h of series.values()) {
        for (let i = 0; i < h.buckets.length; i++) {
          lines.push(
            `${name}_bucket${renderLabels({ ...h.labels, le: String(h.buckets[i]) })} ${h.counts[i] ?? 0}`,
          );
        }
        lines.push(`${name}_bucket${renderLabels({ ...h.labels, le: '+Inf' })} ${h.count}`);
        lines.push(`${name}_sum${renderLabels(h.labels)} ${h.sum}`);
        lines.push(`${name}_count${renderLabels(h.labels)} ${h.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function renderLabels(labels: Labels): string {
  // Sorted so scrape output is byte-stable across runs, which makes diffing
  // two /metrics snapshots useful.
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const body = entries
    .map(
      ([k, v]) =>
        `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
  return `{${body}}`;
}

/** Canonical metric names, so the gateway and the dashboard agree. */
export const METRICS = {
  requests: 'aigw_requests_total',
  requestDuration: 'aigw_request_duration_ms',
  providerAttempts: 'aigw_provider_attempts_total',
  providerDuration: 'aigw_provider_duration_ms',
  timeToFirstToken: 'aigw_time_to_first_token_ms',
  tokens: 'aigw_tokens_total',
  estimatedCost: 'aigw_estimated_cost_total',
  cacheLookups: 'aigw_cache_lookups_total',
  fallbacks: 'aigw_fallbacks_total',
  rateLimited: 'aigw_rate_limited_total',
  budgetBlocks: 'aigw_budget_blocks_total',
  circuitState: 'aigw_circuit_state',
  providerHealth: 'aigw_provider_health',
  gatewayOverhead: 'aigw_gateway_overhead_ms',
} as const;

export function registerDefaultMetrics(registry: MetricsRegistry): void {
  registry.describe(METRICS.requests, 'Gateway requests by status, provider and model.');
  registry.describe(
    METRICS.requestDuration,
    'End-to-end gateway request duration in milliseconds.',
  );
  registry.describe(
    METRICS.providerAttempts,
    'Upstream provider attempts, including retries and fallbacks.',
  );
  registry.describe(METRICS.providerDuration, 'Upstream provider call duration in milliseconds.');
  registry.describe(
    METRICS.timeToFirstToken,
    'Milliseconds from dispatch to the first streamed token.',
  );
  registry.describe(METRICS.tokens, 'Tokens counted by direction and usage source.');
  registry.describe(
    METRICS.estimatedCost,
    'Estimated spend, in the org currency, from the configured price table.',
  );
  registry.describe(METRICS.cacheLookups, 'Cache lookups by result.');
  registry.describe(METRICS.fallbacks, 'Requests where a fallback target served the response.');
  registry.describe(METRICS.rateLimited, 'Requests rejected by a gateway rate limit.');
  registry.describe(METRICS.budgetBlocks, 'Requests blocked or downgraded by a budget rule.');
  registry.describe(METRICS.circuitState, 'Circuit breaker state: 0 closed, 1 half-open, 2 open.');
  registry.describe(
    METRICS.providerHealth,
    'Provider health: 1 healthy, 0.5 degraded, 0 unavailable.',
  );
  registry.describe(
    METRICS.gatewayOverhead,
    'Gateway-added latency, excluding upstream provider time.',
  );
}
