import { bootstrap } from '@ai-gateway/gateway';
import { ConfigError } from '@ai-gateway/config';
import { deliverWebhooks, enforceRetention, evaluateAlerts, probeProviderHealth, type JobDeps, type JobResult } from './jobs.js';

interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: (deps: JobDeps) => Promise<JobResult>;
}

const JOBS: ScheduledJob[] = [
  { name: 'deliver_webhooks', intervalMs: 5_000, run: deliverWebhooks },
  { name: 'probe_provider_health', intervalMs: 60_000, run: probeProviderHealth },
  { name: 'evaluate_alerts', intervalMs: 60_000, run: evaluateAlerts },
  { name: 'enforce_retention', intervalMs: 3_600_000, run: enforceRetention },
];

/**
 * Background worker.
 *
 * A separate process from the gateway on purpose: webhook delivery, health
 * probing and retention sweeps must never compete with an inference request for
 * the event loop. It shares the same bootstrap, so it sees the same providers,
 * store and configuration.
 *
 * `setTimeout` chains rather than `setInterval`: a job that overruns its
 * interval delays the next run instead of stacking up concurrent copies.
 */
async function main(): Promise<void> {
  let booted: Awaited<ReturnType<typeof bootstrap>>;
  try {
    booted = await bootstrap();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n`);
      process.exit(78);
    }
    throw err;
  }

  const { ctx } = booted;
  const logger = ctx.logger.child({ component: 'worker' });
  const deps: JobDeps = {
    store: ctx.store,
    logger,
    health: ctx.health,
    providers: ctx.providers,
    webhooks: ctx.webhooks,
  };

  logger.info('worker starting', { jobs: JOBS.map((j) => `${j.name}@${j.intervalMs}ms`).join(', ') });

  let running = true;
  const timers: NodeJS.Timeout[] = [];

  for (const job of JOBS) {
    const tick = async () => {
      if (!running) return;
      try {
        const result = await job.run(deps);
        if (result.durationMs > job.intervalMs) {
          logger.warn('job overran its interval', {
            job: job.name,
            durationMs: result.durationMs,
            intervalMs: job.intervalMs,
          });
        }
        logger.debug('job completed', { job: job.name, ...result.detail, durationMs: result.durationMs });
      } catch (err) {
        // One failing job must never stop the scheduler.
        logger.error('job failed', { job: job.name, error: (err as Error).message });
      } finally {
        if (running) timers.push(setTimeout(tick, job.intervalMs));
      }
    };
    // Stagger the first runs so four jobs do not all fire at boot.
    timers.push(setTimeout(tick, Math.floor(Math.random() * 2_000)));
  }

  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    logger.info('worker shutting down', { signal });
    for (const timer of timers) clearTimeout(timer);
    await ctx.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
