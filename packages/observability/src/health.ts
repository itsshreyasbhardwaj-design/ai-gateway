import {
  systemClock,
  type Clock,
  type GatewayErrorType,
  type ProviderHealthState,
} from '@ai-gateway/core';

export interface HealthSample {
  at: number;
  ok: boolean;
  latencyMs: number;
  errorType?: GatewayErrorType;
}

export interface HealthStats {
  key: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  errorRate: number;
  timeoutRate: number;
  rateLimitRate: number;
  /** Latency percentiles over successful calls only. */
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgLatencyMs: number;
  state: ProviderHealthState;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  windowMs: number;
}

export interface HealthTrackerConfig {
  windowMs: number;
  maxSamples: number;
  /** Success rate below this, with enough samples, marks a target degraded. */
  degradedBelowSuccessRate: number;
  /** Success rate below this marks it unavailable. */
  unavailableBelowSuccessRate: number;
  /** Samples needed before a rate is trusted at all. */
  minimumSamples: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthTrackerConfig = {
  windowMs: 300_000,
  maxSamples: 1_000,
  degradedBelowSuccessRate: 0.95,
  unavailableBelowSuccessRate: 0.5,
  minimumSamples: 10,
};

/**
 * Rolling health statistics per provider (and per provider/model).
 *
 * This is what the health-aware routing strategies read, and what the
 * provider-comparison dashboard renders. The numbers are measurements of this
 * gateway's own traffic - never a vendor-published SLA and never a quality
 * judgement about the model.
 */
export class HealthTracker {
  private samples = new Map<string, HealthSample[]>();

  constructor(
    private readonly config: HealthTrackerConfig = DEFAULT_HEALTH_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  record(key: string, sample: Omit<HealthSample, 'at'> & { at?: number }): void {
    const list = this.samples.get(key) ?? [];
    list.push({
      at: sample.at ?? this.clock.now(),
      ok: sample.ok,
      latencyMs: sample.latencyMs,
      errorType: sample.errorType,
    });
    if (list.length > this.config.maxSamples) list.splice(0, list.length - this.config.maxSamples);
    this.samples.set(key, list);
  }

  recordSuccess(key: string, latencyMs: number): void {
    this.record(key, { ok: true, latencyMs });
  }

  recordFailure(key: string, latencyMs: number, errorType: GatewayErrorType): void {
    this.record(key, { ok: false, latencyMs, errorType });
  }

  stats(key: string): HealthStats {
    const window = this.windowFor(key);
    const successes = window.filter((s) => s.ok);
    const failures = window.filter((s) => !s.ok);
    const total = window.length;

    const latencies = successes.map((s) => s.latencyMs).sort((a, b) => a - b);
    const successRate = total ? successes.length / total : 1;

    const timeouts = failures.filter((s) => s.errorType === 'provider_timeout').length;
    const rateLimits = failures.filter((s) => s.errorType === 'provider_rate_limit').length;

    return {
      key,
      total,
      successes: successes.length,
      failures: failures.length,
      successRate,
      errorRate: total ? failures.length / total : 0,
      timeoutRate: total ? timeouts / total : 0,
      rateLimitRate: total ? rateLimits / total : 0,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      p99LatencyMs: percentile(latencies, 0.99),
      avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      state: this.classify(total, successRate),
      lastFailureAt: failures.at(-1)?.at,
      lastSuccessAt: successes.at(-1)?.at,
      windowMs: this.config.windowMs,
    };
  }

  allStats(): HealthStats[] {
    return [...this.samples.keys()].map((key) => this.stats(key));
  }

  keys(): string[] {
    return [...this.samples.keys()];
  }

  clear(key?: string): void {
    if (key) this.samples.delete(key);
    else this.samples.clear();
  }

  /**
   * A target with too few samples is `unknown`, not `healthy`. Routing
   * strategies treat unknown as usable-but-unproven rather than penalising a
   * provider that simply has not been tried yet.
   */
  private classify(total: number, successRate: number): ProviderHealthState {
    if (total < this.config.minimumSamples) return 'unknown';
    if (successRate < this.config.unavailableBelowSuccessRate) return 'unavailable';
    if (successRate < this.config.degradedBelowSuccessRate) return 'degraded';
    return 'healthy';
  }

  private windowFor(key: string): HealthSample[] {
    const cutoff = this.clock.now() - this.config.windowMs;
    const list = this.samples.get(key) ?? [];
    const trimmed = list.filter((s) => s.at >= cutoff);
    if (trimmed.length !== list.length) this.samples.set(key, trimmed);
    return trimmed;
  }
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (pos - lower);
}

export function healthScore(state: ProviderHealthState): number {
  switch (state) {
    case 'healthy':
      return 1;
    case 'unknown':
      return 0.75;
    case 'degraded':
      return 0.5;
    case 'unavailable':
      return 0;
  }
}
