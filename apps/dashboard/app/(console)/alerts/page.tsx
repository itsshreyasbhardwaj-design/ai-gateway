import { formatDuration, formatPercent, formatRelativeTime, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, type AlertEventRow, type AlertRuleRow } from '@/lib/gateway';
import { Badge, EmptyState, Mono, Notice, PageHeader, Panel, Table, Td, Th } from '@/components/ui/primitives';
import { ActionForm } from '@/components/action-form';
import { Field, Input, Select } from '@/components/ui/controls';
import { createAlert } from '@/app/actions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Alerts · AI Gateway' };
export const dynamic = 'force-dynamic';

const METRIC_LABELS: Record<string, string> = {
  error_rate: 'Error rate',
  p95_latency_ms: 'p95 latency',
  monthly_cost: 'Estimated spend',
  provider_unavailable: 'Providers unavailable',
  fallback_rate: 'Fallback rate',
};

function formatThreshold(metric: string, value: number): string {
  if (metric === 'error_rate' || metric === 'fallback_rate') return formatPercent(value, 1);
  if (metric === 'p95_latency_ms') return formatDuration(value);
  if (metric === 'monthly_cost') return value.toFixed(2);
  return String(value);
}

export default async function AlertsPage() {
  let rules: AlertRuleRow[] = [];
  let events: AlertEventRow[] = [];
  try {
    const result = await gatewayFetch<{ rules: AlertRuleRow[]; events: AlertEventRow[] }>('/api/v1/alerts');
    rules = result.rules;
    events = result.events;
  } catch (error) {
    return (
      <>
        <PageHeader title="Alerts" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Evaluated by the background worker. A rule fires only when its condition has held for the configured duration, and not again until its cooldown elapses."
      />

      <div className="mb-4">
        <Notice tone="info" title="Two guards against noise">
          A rate metric is ignored below ten requests in the window, because an error rate over three requests is noise
          rather than signal. And a rule that has just fired stays quiet for its cooldown, so a sustained incident pages
          once rather than every minute. Alerts nobody trusts are worse than no alerts.
        </Notice>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Rules">
            {rules.length === 0 ? (
              <EmptyState title="No alert rules" body="Add one to be notified when error rate, latency or spend crosses a threshold." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Rule</Th>
                    <Th>Metric</Th>
                    <Th>Condition</Th>
                    <Th align="right">Sustained for</Th>
                    <Th align="right">Cooldown</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <Td>
                        <span className="text-xs text-zinc-200">{rule.name}</span>
                        <div className="font-mono text-2xs text-zinc-600">{rule.id}</div>
                      </Td>
                      <Td>{METRIC_LABELS[rule.metric] ?? rule.metric}</Td>
                      <Td>
                        <Mono>
                          {rule.comparator === 'gt' ? '>' : '<'} {formatThreshold(rule.metric, rule.threshold)}
                        </Mono>
                      </Td>
                      <Td align="right">{rule.forMinutes}m</Td>
                      <Td align="right">{rule.cooldownMinutes}m</Td>
                      <Td>
                        <Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'enabled' : 'disabled'}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel title="Recent alert events">
            {events.length === 0 ? (
              <EmptyState title="No alerts have fired" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Fired</Th>
                    <Th>Message</Th>
                    <Th align="right">Observed</Th>
                    <Th align="right">Threshold</Th>
                    <Th>Resolved</Th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <Td title={formatTimestamp(event.firedAt)}>
                        <span className="text-2xs text-zinc-500">{formatRelativeTime(event.firedAt)}</span>
                      </Td>
                      <Td className="max-w-lg whitespace-normal">
                        <span className="text-xs leading-relaxed text-zinc-300">{event.message}</span>
                      </Td>
                      <Td align="right">{event.observedValue.toFixed(4)}</Td>
                      <Td align="right">{event.threshold.toFixed(4)}</Td>
                      <Td>
                        {event.resolvedAt ? (
                          <Badge tone="success">resolved</Badge>
                        ) : (
                          <Badge tone="cancelled">open</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        <Panel title="Add a rule">
          <div className="p-4">
            <ActionForm action={createAlert} submitLabel="Create rule">
              <Field label="Name">
                <Input name="name" placeholder="Error rate above 10%" required />
              </Field>
              <Field label="Metric">
                <Select
                  name="metric"
                  className="w-full"
                  defaultValue="error_rate"
                  options={[
                    { value: 'error_rate', label: 'Error rate (%)' },
                    { value: 'p95_latency_ms', label: 'p95 latency (ms)' },
                    { value: 'fallback_rate', label: 'Fallback rate (%)' },
                    { value: 'monthly_cost', label: 'Estimated spend' },
                    { value: 'provider_unavailable', label: 'Providers unavailable (count)' },
                  ]}
                />
              </Field>
              <Field label="Comparator">
                <Select
                  name="comparator"
                  className="w-full"
                  defaultValue="gt"
                  options={[
                    { value: 'gt', label: 'greater than' },
                    { value: 'lt', label: 'less than' },
                  ]}
                />
              </Field>
              <Field label="Threshold" hint="Rate metrics are entered as percentages, e.g. 10 for 10%.">
                <Input name="threshold" type="number" step="0.01" placeholder="10" required />
              </Field>
              <Field label="Sustained for (minutes)" hint="Suppresses single spikes.">
                <Input name="forMinutes" type="number" min="1" defaultValue={5} />
              </Field>
              <Field label="Cooldown (minutes)" hint="Minimum gap between repeat notifications.">
                <Input name="cooldownMinutes" type="number" min="1" defaultValue={30} />
              </Field>
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
