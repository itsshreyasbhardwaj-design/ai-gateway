import { formatRelativeTime, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, type WebhookRow } from '@/lib/gateway';
import { Badge, EmptyState, Mono, Notice, PageHeader, Panel, Pill, Table, Td, Th } from '@/components/ui/primitives';
import { ActionForm, RowAction } from '@/components/action-form';
import { Field, Input } from '@/components/ui/controls';
import { createWebhook, deleteWebhook } from '@/app/actions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Webhooks · AI Gateway' };
export const dynamic = 'force-dynamic';

const EVENTS = [
  { value: 'budget.warning', label: 'budget.warning — approaching a limit' },
  { value: 'budget.exceeded', label: 'budget.exceeded — limit reached' },
  { value: 'provider.degraded', label: 'provider.degraded — health dropped' },
  { value: 'provider.recovered', label: 'provider.recovered — health restored' },
  { value: 'high_error_rate', label: 'high_error_rate — alert rule fired' },
  { value: 'circuit.opened', label: 'circuit.opened' },
  { value: 'circuit.closed', label: 'circuit.closed' },
];

export default async function WebhooksPage() {
  let webhooks: WebhookRow[] = [];
  try {
    const result = await gatewayFetch<{ data: WebhookRow[] }>('/api/v1/webhooks');
    webhooks = result.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Webhooks" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Events are queued to the database, not delivered inline, so a slow endpoint never adds latency to the request that triggered it."
      />

      <div className="mb-4">
        <Notice tone="info" title="Verifying a delivery">
          Each request carries <Mono>x-aigw-signature</Mono> in the form <Mono>t=&lt;unix&gt;,v1=&lt;hex&gt;</Mono>, an
          HMAC-SHA256 over <Mono>&lt;timestamp&gt;.&lt;body&gt;</Mono>. Signing the timestamp alongside the body is what
          makes a captured payload unusable later. Compare in constant time and reject a timestamp outside a few minutes.
          Failed deliveries retry with exponential backoff; an endpoint that fails persistently is disabled rather than
          retried forever.
        </Notice>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Endpoints">
          {webhooks.length === 0 ? (
            <EmptyState title="No webhooks configured" body="Add one to receive budget and provider-health events." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>URL</Th>
                  <Th>Events</Th>
                  <Th>Status</Th>
                  <Th>Last delivery</Th>
                  <Th align="right">Failures</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {webhooks.map((webhook) => (
                  <tr key={webhook.id}>
                    <Td className="max-w-sm truncate" title={webhook.url}>
                      <Mono>{webhook.url}</Mono>
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {webhook.events.map((event) => (
                          <Pill key={event}>{event}</Pill>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={webhook.enabled ? 'success' : 'error'}>
                        {webhook.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </Td>
                    <Td title={webhook.lastDeliveryAt ? formatTimestamp(webhook.lastDeliveryAt) : undefined}>
                      {webhook.lastDeliveryAt ? (
                        <span className="text-2xs text-zinc-500">
                          {formatRelativeTime(webhook.lastDeliveryAt)}
                          {webhook.lastDeliveryStatus && ` · HTTP ${webhook.lastDeliveryStatus}`}
                        </span>
                      ) : (
                        <span className="text-2xs text-zinc-600">never</span>
                      )}
                    </Td>
                    <Td align="right" className={webhook.consecutiveFailures > 0 ? 'text-amber-300' : undefined}>
                      {webhook.consecutiveFailures}
                    </Td>
                    <Td>
                      <RowAction
                        action={deleteWebhook} arg={webhook.id}
                        label="Delete"
                        confirmLabel="Confirm delete"
                        variant="ghost"
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Add an endpoint">
          <div className="p-4">
            <Notice tone="warn" title="URLs are SSRF-checked">
              A webhook target is an outbound request from inside your network, so the same rules apply as to provider
              base URLs: private and link-local addresses are refused unless explicitly allowlisted.
            </Notice>

            <ActionForm
              action={createWebhook}
              submitLabel="Create webhook"
              secretLabel="Your signing secret"
              className="mt-4"
            >
              <Field label="URL">
                <Input name="url" placeholder="https://hooks.example.com/aigw" mono required />
              </Field>
              <div>
                <span className="mb-1 block text-2xs font-medium uppercase tracking-wider text-zinc-500">Events</span>
                <div className="space-y-1.5">
                  {EVENTS.map((event) => (
                    <label key={event.value} className="flex items-start gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        name="events"
                        value={event.value}
                        defaultChecked={event.value.startsWith('budget.')}
                        className="mt-0.5 accent-accent"
                      />
                      <span className="font-mono text-2xs">{event.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
