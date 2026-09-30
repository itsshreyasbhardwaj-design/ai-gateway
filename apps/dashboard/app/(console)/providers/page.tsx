import {
  CIRCUIT_TONES,
  formatDuration,
  formatNumber,
  formatPercent,
  HEALTH_TONES,
} from '@ai-gateway/ui';
import { gatewayFetch, type ProviderRow } from '@/lib/gateway';
import {
  Badge,
  EmptyState,
  KeyValue,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { ActionForm, RowAction } from '@/components/action-form';
import { Field, Input, Select } from '@/components/ui/controls';
import { createProvider, deleteProvider, probeProvider, resetCircuits } from '@/app/actions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Providers · AI Gateway' };
export const dynamic = 'force-dynamic';

export default async function ProvidersPage() {
  let providers: ProviderRow[];
  try {
    const result = await gatewayFetch<{ data: ProviderRow[] }>('/api/v1/providers');
    providers = result.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Providers" />
        <GatewayError error={error} />
      </>
    );
  }

  const unregistered = providers.filter((p) => !p.registered);

  return (
    <>
      <PageHeader
        title="Providers"
        description="Health figures are measurements of this gateway's own traffic over its health window, not vendor-published availability."
        actions={
          <RowAction
            action={resetCircuits}
            label="Reset circuit breakers"
            title="Close every open circuit. Use after fixing a credential or an upstream outage."
          />
        }
      />

      {unregistered.length > 0 && (
        <div className="mb-4">
          <Notice
            tone="warn"
            title={`${unregistered.length} provider(s) configured but not registered`}
          >
            These are stored but could not be constructed at boot — usually a missing credential or
            no configured models. They cannot serve traffic until that is fixed:{' '}
            {unregistered.map((p) => p.id).join(', ')}.
          </Notice>
        </div>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Registered providers">
            {providers.length === 0 ? (
              <EmptyState
                title="No providers configured"
                body="Set a provider API key in the gateway's environment, or add a custom OpenAI-compatible endpoint below."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Provider</Th>
                    <Th>Kind</Th>
                    <Th>State</Th>
                    <Th align="right">Models</Th>
                    <Th align="right">Requests</Th>
                    <Th align="right">Success</Th>
                    <Th align="right">p50</Th>
                    <Th align="right">p95</Th>
                    <Th align="right">Timeouts</Th>
                    <Th align="right">429s</Th>
                    <Th>Credential</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {providers.map((provider) => (
                    <tr key={provider.id}>
                      <Td>
                        <Mono className="text-zinc-200">{provider.id}</Mono>
                        <div className="text-2xs text-zinc-600">{provider.displayName}</div>
                        {provider.baseUrl && (
                          <div
                            className="mt-0.5 max-w-xs truncate font-mono text-2xs text-zinc-600"
                            title={provider.baseUrl}
                          >
                            {provider.baseUrl}
                          </div>
                        )}
                      </Td>
                      <Td>
                        <span className="text-xs text-zinc-400">{provider.kind}</span>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            provider.registered
                              ? (HEALTH_TONES[provider.health.state] ?? 'neutral')
                              : 'error'
                          }
                        >
                          {provider.registered ? provider.health.state : 'not registered'}
                        </Badge>
                      </Td>
                      <Td align="right">{provider.models}</Td>
                      <Td align="right">{formatNumber(provider.health.total)}</Td>
                      <Td align="right">
                        {provider.health.total > 0 ? (
                          formatPercent(provider.health.successRate, 2)
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        {provider.health.total > 0 ? (
                          formatDuration(provider.health.p50LatencyMs)
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        {provider.health.total > 0 ? (
                          formatDuration(provider.health.p95LatencyMs)
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        {provider.health.total > 0 ? (
                          formatPercent(provider.health.timeoutRate, 1)
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        {provider.health.total > 0 ? (
                          formatPercent(provider.health.rateLimitRate, 1)
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </Td>
                      <Td>
                        {provider.credential ? (
                          <Mono title="A reference to an environment variable or an encrypted stored secret. The value is never returned by the API.">
                            {provider.credential.ref}
                          </Mono>
                        ) : (
                          <span className="text-2xs text-zinc-600">none</span>
                        )}
                      </Td>
                      <Td>
                        <span className="flex items-center gap-1">
                          <RowAction
                            action={probeProvider}
                            arg={provider.id}
                            label="Probe"
                            title="Send a health probe to this provider now."
                          />
                          <RowAction
                            action={deleteProvider}
                            arg={provider.id}
                            label="Remove"
                            confirmLabel="Confirm remove"
                            variant="ghost"
                          />
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          {providers.length > 0 && (
            <Panel title="Health window">
              <div className="grid gap-x-8 md:grid-cols-2">
                {providers.map((provider) => (
                  <KeyValue key={provider.id} label={provider.id}>
                    {provider.health.total === 0
                      ? 'no samples yet'
                      : `${formatNumber(provider.health.total)} requests over the last ${Math.round(provider.health.windowMs / 60_000)} minutes`}
                  </KeyValue>
                ))}
              </div>
            </Panel>
          )}
        </div>

        <Panel
          title="Add a custom provider"
          subtitle="Any endpoint speaking the OpenAI chat-completions wire format"
        >
          <div className="p-4">
            <Notice tone="warn" title="Base URLs are SSRF-checked">
              A private or link-local address is refused unless the operator has allowlisted that
              host via <Mono>PROVIDER_ALLOWED_HOSTS</Mono>. Cloud metadata endpoints are always
              refused.
            </Notice>

            <ActionForm action={createProvider} submitLabel="Register provider" className="mt-4">
              <Field
                label="Provider id"
                hint="Lowercase, used as the prefix in model ids: myvendor/model-name."
              >
                <Input name="id" placeholder="myvendor" mono required />
              </Field>
              <Field label="Display name">
                <Input name="displayName" placeholder="My Vendor" required />
              </Field>
              <Field label="Kind">
                <Select
                  name="kind"
                  className="w-full"
                  defaultValue="openai-compatible"
                  options={[
                    { value: 'openai-compatible', label: 'OpenAI-compatible' },
                    { value: 'openai', label: 'OpenAI' },
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'google', label: 'Google Gemini' },
                    { value: 'openrouter', label: 'OpenRouter' },
                    { value: 'local', label: 'Self-hosted (vLLM, Ollama, LM Studio)' },
                  ]}
                />
              </Field>
              <Field
                label="Base URL"
                hint="Leave empty to use the built-in default for a known vendor."
              >
                <Input name="baseUrl" placeholder="https://api.myvendor.example/v1" mono />
              </Field>
              <Field
                label="API key"
                hint="Encrypted with AES-256-GCM before storage and never returned by the API."
              >
                <Input name="credentialValue" type="password" mono placeholder="sk-…" />
              </Field>
              <Field
                label="Models"
                hint="Space or comma separated upstream model ids. Required for an endpoint the gateway has no catalog for."
              >
                <Input name="models" placeholder="model-small model-large" mono />
              </Field>
              <Field label="Context window" hint="Applied to each model listed above.">
                <Input name="contextWindow" type="number" defaultValue={8192} min="1" />
              </Field>
            </ActionForm>
          </div>
        </Panel>
      </div>

      <p className="mt-3 text-2xs leading-relaxed text-zinc-600">
        Circuit states: <Badge tone={CIRCUIT_TONES['CLOSED']!}>closed</Badge> routing normally,{' '}
        <Badge tone={CIRCUIT_TONES['HALF_OPEN']!}>half-open</Badge> probing after a back-off, and{' '}
        <Badge tone={CIRCUIT_TONES['OPEN']!}>open</Badge> excluded until the next probe window.
        Tripping requires either a run of consecutive failures or a sustained failure rate over a
        minimum call volume, so one bad request never removes a provider.
      </p>
    </>
  );
}
