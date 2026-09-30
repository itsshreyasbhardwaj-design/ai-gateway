import { cpus, loadavg, totalmem, type CpuInfo } from 'node:os';

/**
 * Benchmark harness.
 *
 * Three things it takes seriously:
 *
 *  1. It reports percentiles, not averages. A mean latency hides exactly the
 *     tail a gateway exists to manage.
 *  2. It separates gateway overhead from provider time, because "the gateway
 *     adds 2ms" and "the model took 900ms" are different facts and only one of
 *     them is the gateway's responsibility.
 *  3. It records the machine and its load alongside every result, so a number
 *     measured on a loaded laptop is never mistaken for a capacity figure.
 */

export interface LatencySummary {
  count: number;
  min: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface BenchmarkResult {
  name: string;
  description: string;
  durationMs: number;
  requests: number;
  errors: number;
  requestsPerSecond: number;
  concurrency: number;
  /** End-to-end, as the client saw it. */
  latency: LatencySummary;
  /** Time attributable to the gateway itself, excluding upstream provider time. */
  gatewayOverhead?: LatencySummary;
  providerTime?: LatencySummary;
  notes: string[];
}

export interface Environment {
  node: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryGb: number;
  loadAverage: [number, number, number];
  /** True when the machine was already busy, which invalidates throughput. */
  loaded: boolean;
  timestamp: string;
}

export function captureEnvironment(): Environment {
  const cpu: CpuInfo | undefined = cpus()[0];
  const load = loadavg() as [number, number, number];
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpu?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    loadAverage: load,
    // One core's worth of load per core is already saturated.
    loaded: load[0] > cpus().length * 0.7,
    timestamp: new Date().toISOString(),
  };
}

export function summarize(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  return {
    count: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p75: round(at(0.75)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface RunOptions {
  name: string;
  description: string;
  /** Iterations discarded before measurement, to let the JIT settle. */
  warmup: number;
  iterations: number;
  concurrency: number;
  notes?: string[];
}

export interface Measurement {
  latencyMs: number;
  gatewayOverheadMs?: number;
  providerMs?: number;
  ok: boolean;
}

/** Run `fn` at a fixed concurrency and summarize the result. */
export async function run(
  options: RunOptions,
  fn: (iteration: number) => Promise<Measurement>,
): Promise<BenchmarkResult> {
  for (let i = 0; i < options.warmup; i++) {
    await fn(-1).catch(() => undefined);
  }

  const latencies: number[] = [];
  const overheads: number[] = [];
  const providerTimes: number[] = [];
  let errors = 0;
  let issued = 0;

  const startedAt = performance.now();

  const worker = async () => {
    for (;;) {
      const index = issued++;
      if (index >= options.iterations) return;
      try {
        const measurement = await fn(index);
        if (!measurement.ok) errors++;
        latencies.push(measurement.latencyMs);
        if (measurement.gatewayOverheadMs !== undefined)
          overheads.push(measurement.gatewayOverheadMs);
        if (measurement.providerMs !== undefined) providerTimes.push(measurement.providerMs);
      } catch {
        errors++;
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));
  const durationMs = performance.now() - startedAt;

  return {
    name: options.name,
    description: options.description,
    durationMs: round(durationMs),
    requests: latencies.length,
    errors,
    requestsPerSecond: round((latencies.length / durationMs) * 1000),
    concurrency: options.concurrency,
    latency: summarize(latencies),
    gatewayOverhead: overheads.length ? summarize(overheads) : undefined,
    providerTime: providerTimes.length ? summarize(providerTimes) : undefined,
    notes: options.notes ?? [],
  };
}

export function formatTable(results: BenchmarkResult[]): string {
  const header = ['BENCHMARK', 'REQS', 'ERR', 'REQ/S', 'p50', 'p95', 'p99', 'MAX'];
  const rows = results.map((result) => [
    result.name,
    String(result.requests),
    String(result.errors),
    result.requestsPerSecond.toFixed(0),
    `${result.latency.p50.toFixed(2)}ms`,
    `${result.latency.p95.toFixed(2)}ms`,
    `${result.latency.p99.toFixed(2)}ms`,
    `${result.latency.max.toFixed(2)}ms`,
  ]);

  const widths = header.map((_, i) =>
    Math.max(header[i]!.length, ...rows.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join('  ');

  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function describeEnvironment(env: Environment): string {
  return [
    `node ${env.node} · ${env.platform}/${env.arch}`,
    `${env.cpuCount} x ${env.cpuModel.trim()}`,
    `${env.totalMemoryGb} GB RAM`,
    `load average ${env.loadAverage.map((n) => n.toFixed(2)).join(' ')}`,
  ].join('\n  ');
}
