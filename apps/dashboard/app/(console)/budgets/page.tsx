import { formatCurrency, formatPercent, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, type ApiKeyRow, type BudgetStateRow, type ProjectRow } from '@/lib/gateway';
import {
  Badge,
  EmptyState,
  Meter,
  Notice,
  PageHeader,
  Panel,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { ActionForm, RowAction } from '@/components/action-form';
import { Field, Input, Select } from '@/components/ui/controls';
import { createBudget, deleteBudget } from '@/app/actions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Budgets · AI Gateway' };
export const dynamic = 'force-dynamic';

const ACTION_DESCRIPTIONS: Record<string, string> = {
  BLOCK: 'Refuse the request with 402 before it reaches a provider.',
  WARN: 'Allow the request, record the overage and fire a webhook.',
  FALLBACK_TO_CHEAPER_MODEL: 'Restrict routing to targets that fit inside the remaining budget.',
};

export default async function BudgetsPage() {
  let budgets: BudgetStateRow[] = [];
  let projects: ProjectRow[] = [];
  let keys: ApiKeyRow[] = [];
  try {
    const [budgetResult, projectResult, keyResult] = await Promise.all([
      gatewayFetch<{ data: BudgetStateRow[] }>('/api/v1/budgets'),
      gatewayFetch<{ data: ProjectRow[] }>('/api/v1/projects').catch(() => ({
        data: [] as ProjectRow[],
      })),
      gatewayFetch<{ data: ApiKeyRow[] }>('/api/v1/api-keys').catch(() => ({
        data: [] as ApiKeyRow[],
      })),
    ]);
    budgets = budgetResult.data;
    projects = projectResult.data;
    keys = keyResult.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Budgets" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Evaluated before a request is dispatched, using its projected worst-case cost. A configured budget is never bypassed silently, and a BLOCK at any scope wins over a softer action at another."
      />

      <div className="mb-4">
        <Notice tone="info" title="Spend is measured against the configured price table">
          Budget accounting uses the same estimated costs shown elsewhere in the dashboard, not
          provider invoices. If the price table is unverified, budget thresholds are approximate in
          the same way. Test traffic (playground, simulations, replays) is metered for rate limits
          but never charged against a budget.
        </Notice>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Active budgets">
          {budgets.length === 0 ? (
            <EmptyState
              title="No budgets configured"
              body="Without one, spend is recorded and reported but never capped. Add a budget to put a ceiling on it."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Scope</Th>
                  <Th>Period</Th>
                  <Th align="right">Limit</Th>
                  <Th align="right">Spent</Th>
                  <Th align="right">Remaining</Th>
                  <Th>Utilization</Th>
                  <Th>On limit</Th>
                  <Th>Resets</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {budgets.map((state) => {
                  const tone =
                    state.utilization >= 1
                      ? 'danger'
                      : state.utilization >= 0.8
                        ? 'warn'
                        : 'default';
                  const scopeLabel =
                    state.budget.scope === 'organization'
                      ? 'organization'
                      : state.budget.scope === 'project'
                        ? (projects.find((p) => p.id === state.budget.scopeId)?.slug ??
                          state.budget.scopeId ??
                          'project')
                        : (keys.find((k) => k.id === state.budget.scopeId)?.name ??
                          state.budget.scopeId ??
                          'api key');
                  return (
                    <tr key={state.budget.id}>
                      <Td>
                        <span className="text-xs text-zinc-200">{scopeLabel}</span>
                        <div className="text-2xs text-zinc-600">{state.budget.scope}</div>
                      </Td>
                      <Td>{state.budget.period}</Td>
                      <Td align="right">
                        {formatCurrency(state.budget.limit, state.budget.currency)}
                      </Td>
                      <Td
                        align="right"
                        className={
                          tone === 'danger'
                            ? 'text-red-300'
                            : tone === 'warn'
                              ? 'text-amber-300'
                              : undefined
                        }
                      >
                        {formatCurrency(state.spent, state.budget.currency)}
                      </Td>
                      <Td align="right">
                        {formatCurrency(state.remaining, state.budget.currency)}
                      </Td>
                      <Td className="w-32">
                        <div className="flex items-center gap-2">
                          <Meter value={state.utilization} tone={tone} />
                          <span className="tabular w-12 shrink-0 text-right text-2xs text-zinc-400">
                            {formatPercent(state.utilization, 0)}
                          </span>
                        </div>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            state.budget.action === 'BLOCK'
                              ? 'error'
                              : state.budget.action === 'WARN'
                                ? 'cancelled'
                                : 'pending'
                          }
                          title={ACTION_DESCRIPTIONS[state.budget.action]}
                        >
                          {state.budget.action === 'FALLBACK_TO_CHEAPER_MODEL'
                            ? 'downgrade'
                            : state.budget.action.toLowerCase()}
                        </Badge>
                        {state.budget.warnThreshold !== undefined && (
                          <span className="ml-1.5 text-2xs text-zinc-600">
                            warn at {formatPercent(state.budget.warnThreshold, 0)}
                          </span>
                        )}
                      </Td>
                      <Td title={formatTimestamp(state.periodEnd)}>
                        <span className="text-2xs text-zinc-500">
                          {formatTimestamp(state.periodEnd).slice(0, 10)}
                        </span>
                      </Td>
                      <Td>
                        <RowAction
                          action={deleteBudget}
                          arg={state.budget.id}
                          label="Delete"
                          confirmLabel="Confirm delete"
                          variant="ghost"
                        />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Add a budget">
          <div className="p-4">
            <ActionForm action={createBudget} submitLabel="Create budget">
              <Field label="Scope">
                <Select
                  name="scope"
                  className="w-full"
                  defaultValue="organization"
                  options={[
                    { value: 'organization', label: 'Organization (all traffic)' },
                    { value: 'project', label: 'Project' },
                    { value: 'api_key', label: 'API key' },
                  ]}
                />
              </Field>
              <Field
                label="Scope id"
                hint="Required for a project or API-key budget. Leave empty for the organization."
              >
                <Select
                  name="scopeId"
                  className="w-full"
                  options={[
                    { value: '', label: '(organization)' },
                    ...projects.map((p) => ({ value: p.id, label: `project · ${p.slug}` })),
                    ...keys
                      .filter((k) => k.status === 'active')
                      .map((k) => ({ value: k.id, label: `key · ${k.name}` })),
                  ]}
                />
              </Field>
              <Field label="Period">
                <Select
                  name="period"
                  className="w-full"
                  defaultValue="monthly"
                  options={[
                    { value: 'daily', label: 'Daily (UTC)' },
                    { value: 'monthly', label: 'Monthly (UTC)' },
                  ]}
                />
              </Field>
              <Field label="Limit">
                <Input name="limit" type="number" step="0.01" min="0" placeholder="500" required />
              </Field>
              <Field label="Currency">
                <Select
                  name="currency"
                  className="w-full"
                  defaultValue="USD"
                  options={[
                    { value: 'USD', label: 'USD' },
                    { value: 'INR', label: 'INR' },
                    { value: 'EUR', label: 'EUR' },
                  ]}
                />
              </Field>
              <Field label="When the limit is reached">
                <Select
                  name="action"
                  className="w-full"
                  defaultValue="BLOCK"
                  options={[
                    { value: 'BLOCK', label: 'BLOCK — refuse with 402' },
                    { value: 'WARN', label: 'WARN — allow and record' },
                    { value: 'FALLBACK_TO_CHEAPER_MODEL', label: 'Downgrade to a cheaper model' },
                  ]}
                />
              </Field>
              <Field
                label="Warn at (%)"
                hint="Optional. Fires a budget.warning webhook before the limit is hit."
              >
                <Input name="warnThreshold" type="number" min="1" placeholder="80" />
              </Field>
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
