import { newId } from '@ai-gateway/core';
import type { AlertRule, ProviderHealthSnapshot, Store } from '@ai-gateway/database';
import type { HealthTracker, Logger } from '@ai-gateway/observability';
import type { ProviderRegistry } from '@ai-gateway/provider-sdk';
import { resolveRange, summarize } from '@ai-gateway/usage';
import type { WebhookDispatcher } from '@ai-gateway/gateway';

export interface JobDeps {
  store: Store;
  logger: Logger;
  health: HealthTracker;
  providers: ProviderRegistry;
  webhooks: WebhookDispatcher;
}

export interface JobResult {
  name: string;
  ok: boolean;
  detail: Record<string, unknown>;
  durationMs: number;
}

/**
 * Background jobs.
 *
 * Each is idempotent and independently scheduled, so a slow one never blocks
 * the others and a crash mid-run cannot corrupt state. Everything here is work
 * that must not sit in the request path: probing providers, honouring retention,
 * evaluating alerts, delivering webhooks.
 */
export async function probeProviderHealth(deps: JobDeps): Promise<JobResult> {
  const startedAt = Date.now();
  const results: Record<string, string> = {};
  const transitions: Array<{ provider: string; from: string; to: string }> = [];

  for (const provider of deps.providers.listProviders()) {
    const previous = deps.health.stats(provider.id).state;
    try {
      const probe = await provider.healthCheck();
      results[provider.id] = probe.state;

      const measured = deps.health.stats(provider.id);
      const snapshot: ProviderHealthSnapshot = {
        id: newId('hlth'),
        providerId: provider.id,
        state: probe.state,
        latencyMs: probe.latencyMs,
        successRate: measured.successRate,
        p95LatencyMs: Math.round(measured.p95LatencyMs),
        sampleCount: measured.total,
        message: probe.message,
        checkedAt: probe.checkedAt,
      };
      await deps.store.recordHealthSnapshot(snapshot);

      // Only notify on a genuine transition; a provider that is simply still
      // degraded should not page anyone every 30 seconds.
      if (previous !== probe.state && previous !== 'unknown') {
        transitions.push({ provider: provider.id, from: previous, to: probe.state });
      }
    } catch (err) {
      results[provider.id] = 'probe_failed';
      deps.logger.warn('provider health probe failed', {
        provider: provider.id,
        error: (err as Error).message,
      });
    }
  }

  for (const organization of await deps.store.listOrganizations()) {
    for (const transition of transitions) {
      const recovered = transition.to === 'healthy';
      await deps.webhooks
        .emit({
          event: recovered ? 'provider.recovered' : 'provider.degraded',
          organizationId: organization.id,
          occurredAt: new Date().toISOString(),
          data: transition,
        })
        .catch(() => undefined);
    }
  }

  return {
    name: 'probe_provider_health',
    ok: true,
    detail: { probed: Object.keys(results).length, results, transitions: transitions.length },
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Enforce prompt retention.
 *
 * The organization privacy setting is a promise about how long bodies are kept;
 * this is the job that actually keeps it. It runs on a timer and never skips on
 * error, because a retention window that quietly stops being enforced is worse
 * than one that was never offered.
 */
export async function enforceRetention(deps: JobDeps): Promise<JobResult> {
  const startedAt = Date.now();
  const now = new Date();

  const bodiesRemoved = await deps.store.prunePromptBodies(now);

  let requestsRemoved = 0;
  for (const organization of await deps.store.listOrganizations()) {
    // Request metadata is retained for analytics on a separate, longer horizon
    // than bodies: 10x the body window, with a 90-day floor.
    const days = Math.max(90, organization.privacy.retentionDays * 10);
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    requestsRemoved += await deps.store.pruneRequests(organization.id, cutoff);
  }

  if (bodiesRemoved > 0 || requestsRemoved > 0) {
    deps.logger.info('retention enforced', { bodiesRemoved, requestsRemoved });
  }

  return {
    name: 'enforce_retention',
    ok: true,
    detail: { bodiesRemoved, requestsRemoved },
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Evaluate alert rules.
 *
 * Two guards against noise: a rule must exceed its threshold, and the rule's
 * cooldown must have elapsed since it last fired. Alerts nobody trusts are
 * worse than no alerts.
 */
export async function evaluateAlerts(deps: JobDeps): Promise<JobResult> {
  const startedAt = Date.now();
  let fired = 0;
  let suppressed = 0;

  for (const organization of await deps.store.listOrganizations()) {
    const rules = (await deps.store.listAlertRules(organization.id)).filter((r) => r.enabled);
    if (rules.length === 0) continue;

    for (const rule of rules) {
      const range = resolveRange('1h');
      const { records } = await deps.store.queryRequests({
        organizationId: organization.id,
        from: new Date(Date.now() - rule.forMinutes * 60_000),
        to: new Date(),
        limit: 500,
      });
      const summary = summarize(records);

      const observed = observedValue(rule, summary, deps, organization.id);
      if (observed === null) continue;

      const breached = rule.comparator === 'gt' ? observed > rule.threshold : observed < rule.threshold;
      if (!breached) continue;

      const last = await deps.store.lastAlertEvent(rule.id);
      if (last && Date.now() - Date.parse(last.firedAt) < rule.cooldownMinutes * 60_000) {
        suppressed++;
        continue;
      }

      const message = describeAlert(rule, observed);
      await deps.store.recordAlertEvent({
        id: newId('alr'),
        alertId: rule.id,
        organizationId: organization.id,
        firedAt: new Date().toISOString(),
        observedValue: observed,
        threshold: rule.threshold,
        message,
      });
      await deps.webhooks
        .emit({
          event: rule.metric === 'error_rate' ? 'high_error_rate' : 'provider.degraded',
          organizationId: organization.id,
          occurredAt: new Date().toISOString(),
          data: { alertId: rule.id, name: rule.name, metric: rule.metric, observed, threshold: rule.threshold, message, window: range },
        })
        .catch(() => undefined);

      deps.logger.warn('alert fired', { alertId: rule.id, metric: rule.metric, observed, threshold: rule.threshold });
      fired++;
    }
  }

  return {
    name: 'evaluate_alerts',
    ok: true,
    detail: { fired, suppressed },
    durationMs: Date.now() - startedAt,
  };
}

function observedValue(
  rule: AlertRule,
  summary: ReturnType<typeof summarize>,
  deps: JobDeps,
  _organizationId: string,
): number | null {
  switch (rule.metric) {
    case 'error_rate':
      // Below a handful of requests an error rate is noise, not signal.
      return summary.totalRequests >= 10 ? 1 - summary.successRate : null;
    case 'p95_latency_ms':
      return summary.totalRequests >= 10 ? summary.p95LatencyMs : null;
    case 'fallback_rate':
      return summary.totalRequests >= 10 ? summary.fallbackRate : null;
    case 'monthly_cost':
      return summary.estimatedCost;
    case 'provider_unavailable': {
      const unavailable = deps.providers
        .listProviderIds()
        .filter((id) => deps.health.stats(id).state === 'unavailable');
      return unavailable.length;
    }
    default:
      return null;
  }
}

function describeAlert(rule: AlertRule, observed: number): string {
  const direction = rule.comparator === 'gt' ? 'above' : 'below';
  switch (rule.metric) {
    case 'error_rate':
      return `Error rate ${(observed * 100).toFixed(1)}% is ${direction} the ${(rule.threshold * 100).toFixed(1)}% threshold over the last ${rule.forMinutes} minutes.`;
    case 'p95_latency_ms':
      return `p95 latency ${Math.round(observed)}ms is ${direction} the ${rule.threshold}ms threshold.`;
    case 'fallback_rate':
      return `Fallback rate ${(observed * 100).toFixed(1)}% is ${direction} the ${(rule.threshold * 100).toFixed(1)}% threshold.`;
    case 'monthly_cost':
      return `Estimated spend ${observed.toFixed(2)} is ${direction} the ${rule.threshold} threshold. Computed from the configured price table.`;
    case 'provider_unavailable':
      return `${observed} provider(s) are measured as unavailable.`;
    default:
      return `${rule.metric} is ${observed}, ${direction} ${rule.threshold}.`;
  }
}

export async function deliverWebhooks(deps: JobDeps): Promise<JobResult> {
  const startedAt = Date.now();
  const result = await deps.webhooks.drain(25);
  if (result.delivered || result.failed || result.retried) {
    deps.logger.info('webhook queue drained', result);
  }
  return {
    name: 'deliver_webhooks',
    ok: true,
    detail: { ...result },
    durationMs: Date.now() - startedAt,
  };
}
