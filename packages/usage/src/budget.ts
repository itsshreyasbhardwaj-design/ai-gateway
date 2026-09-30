import { GatewayError } from '@ai-gateway/core';

export type BudgetScope = 'organization' | 'project' | 'api_key';
export type BudgetPeriod = 'daily' | 'monthly';

/** What happens when a budget is reached. Always explicit; never silent. */
export type BudgetAction = 'BLOCK' | 'WARN' | 'FALLBACK_TO_CHEAPER_MODEL';

export interface Budget {
  id: string;
  organizationId: string;
  scope: BudgetScope;
  /** Project or API key id when the scope is narrower than the organization. */
  scopeId?: string;
  period: BudgetPeriod;
  /** Limit in the organization currency. */
  limit: number;
  currency: string;
  action: BudgetAction;
  /** Fraction of the limit that fires a `budget.warning` webhook, e.g. 0.8. */
  warnThreshold?: number;
  enabled: boolean;
}

export interface BudgetState {
  budget: Budget;
  spent: number;
  remaining: number;
  utilization: number;
  periodStart: string;
  periodEnd: string;
}

export type BudgetOutcome =
  | { decision: 'allow'; states: BudgetState[]; warnings: BudgetState[] }
  | { decision: 'block'; blocked: BudgetState; states: BudgetState[]; warnings: BudgetState[] }
  | {
      decision: 'downgrade';
      trigger: BudgetState;
      states: BudgetState[];
      warnings: BudgetState[];
      maxSpend: number;
    };

export interface BudgetCheckInput {
  states: BudgetState[];
  /** Worst-case cost of the request about to be made. */
  projectedCost: number;
}

/**
 * Evaluate every budget that covers a request.
 *
 * The rule the gateway will not bend: a configured budget is never bypassed
 * silently. If spend accounting is unavailable the request is blocked rather
 * than waved through, and every decision - including a downgrade - is recorded
 * on the request trace and surfaced in the response's routing receipt.
 *
 * Precedence is by severity, not by scope: one BLOCK anywhere blocks.
 */
export function evaluateBudgets(input: BudgetCheckInput): BudgetOutcome {
  const active = input.states.filter((s) => s.budget.enabled);
  const warnings = active.filter((s) => {
    const threshold = s.budget.warnThreshold;
    return threshold !== undefined && s.utilization >= threshold;
  });

  const exceeded = active.filter((s) => s.spent + input.projectedCost > s.budget.limit);
  if (exceeded.length === 0) {
    return { decision: 'allow', states: active, warnings };
  }

  const blocking = exceeded.find((s) => s.budget.action === 'BLOCK');
  if (blocking) {
    return { decision: 'block', blocked: blocking, states: active, warnings };
  }

  const downgrade = exceeded.find((s) => s.budget.action === 'FALLBACK_TO_CHEAPER_MODEL');
  if (downgrade) {
    return {
      decision: 'downgrade',
      trigger: downgrade,
      states: active,
      warnings,
      maxSpend: Math.max(0, downgrade.remaining),
    };
  }

  // Everything left is WARN: the request proceeds, but the overage is recorded.
  return { decision: 'allow', states: active, warnings: [...new Set([...warnings, ...exceeded])] };
}

export function budgetError(state: BudgetState): GatewayError {
  const period = state.budget.period === 'daily' ? 'daily' : 'monthly';
  return new GatewayError(
    'budget_exceeded',
    `The ${period} ${state.budget.scope.replace('_', ' ')} budget of ${state.budget.limit} ${state.budget.currency} has been reached.`,
    {
      details: {
        budgetId: state.budget.id,
        scope: state.budget.scope,
        period: state.budget.period,
        limit: state.budget.limit,
        spent: Number(state.spent.toFixed(6)),
        currency: state.budget.currency,
        periodEnd: state.periodEnd,
      },
    },
  );
}

/** UTC period bounds. Budgets are defined in UTC so they do not shift with a viewer's timezone. */
export function periodBounds(
  period: BudgetPeriod,
  now = new Date(),
): { start: Date; end: Date; key: string } {
  if (period === 'daily') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start.getTime() + 86_400_000);
    return { start, end, key: start.toISOString().slice(0, 10) };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

export function buildState(budget: Budget, spent: number, now = new Date()): BudgetState {
  const { start, end } = periodBounds(budget.period, now);
  return {
    budget,
    spent,
    remaining: Math.max(0, budget.limit - spent),
    utilization: budget.limit > 0 ? spent / budget.limit : 0,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}
