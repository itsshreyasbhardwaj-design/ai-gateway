import type { KeyValueStore } from '@ai-gateway/cache';
import { periodBounds, type Budget, type BudgetPeriod, type BudgetScope } from './budget.js';

/**
 * Spend counters.
 *
 * Kept in the KV store rather than derived from the requests table on every
 * call: a budget check sits in the hot path and must not turn into an
 * aggregate query. The requests table stays the source of truth, and
 * `reconcile` rebuilds a counter from it when they disagree.
 */
export class SpendCounters {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly namespace = 'spend',
  ) {}

  private key(
    organizationId: string,
    scope: BudgetScope,
    scopeId: string,
    period: BudgetPeriod,
    now: Date,
  ): string {
    const { key } = periodBounds(period, now);
    return [this.namespace, organizationId, scope, scopeId, period, key].join(':');
  }

  /** TTL past the period end so a stale counter cannot outlive its window. */
  private ttlFor(period: BudgetPeriod, now: Date): number {
    const { end } = periodBounds(period, now);
    return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000) + 86_400);
  }

  async add(
    organizationId: string,
    scope: BudgetScope,
    scopeId: string,
    period: BudgetPeriod,
    amount: number,
    now = new Date(),
  ): Promise<number> {
    if (amount === 0) return this.read(organizationId, scope, scopeId, period, now);
    return this.kv.incrByFloat(
      this.key(organizationId, scope, scopeId, period, now),
      amount,
      this.ttlFor(period, now),
    );
  }

  async read(
    organizationId: string,
    scope: BudgetScope,
    scopeId: string,
    period: BudgetPeriod,
    now = new Date(),
  ): Promise<number> {
    const raw = await this.kv.get(this.key(organizationId, scope, scopeId, period, now));
    return raw ? Number(raw) || 0 : 0;
  }

  async readForBudget(budget: Budget, now = new Date()): Promise<number> {
    const scopeId = budget.scopeId ?? budget.organizationId;
    return this.read(budget.organizationId, budget.scope, scopeId, budget.period, now);
  }

  /** Record one request's cost against every scope that could have a budget. */
  async record(
    ctx: { organizationId: string; projectId: string; apiKeyId: string },
    amount: number,
    now = new Date(),
  ): Promise<void> {
    if (amount <= 0) return;
    const targets: Array<[BudgetScope, string]> = [
      ['organization', ctx.organizationId],
      ['project', ctx.projectId],
      ['api_key', ctx.apiKeyId],
    ];
    for (const [scope, scopeId] of targets) {
      for (const period of ['daily', 'monthly'] as BudgetPeriod[]) {
        await this.add(ctx.organizationId, scope, scopeId, period, amount, now);
      }
    }
  }

  /** Overwrite a counter with a value recomputed from the requests table. */
  async reconcile(
    organizationId: string,
    scope: BudgetScope,
    scopeId: string,
    period: BudgetPeriod,
    trueValue: number,
    now = new Date(),
  ): Promise<void> {
    await this.kv.set(
      this.key(organizationId, scope, scopeId, period, now),
      String(trueValue),
      this.ttlFor(period, now),
    );
  }
}
