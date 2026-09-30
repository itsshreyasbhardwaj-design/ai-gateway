import {
  CIRCUIT_TONES, formatCompact, formatCurrency, formatDuration, formatNumber, formatPercent, HEALTH_TONES,
} from '@ai-gateway/ui';
import { gatewayFetch, type ModelRow } from '@/lib/gateway';
import { Badge, EmptyState, Mono, Notice, PageHeader, Panel, Pill, Table, Td, Th } from '@/components/ui/primitives';
import { QueryFilter, SearchBox } from '@/components/ui/controls';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Models · AI Gateway' };
export const dynamic = 'force-dynamic';

const CAPABILITIES = ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode', 'embeddings', 'reasoning'];

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string; capability?: string; status?: string; search?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['provider', 'capability', 'status', 'search'] as const) {
    if (params[key]) query.set(key, params[key]!);
  }

  let models: ModelRow[];
  let pricingVersion = '';
  let pricingAgeDays = 0;
  try {
    const result = await gatewayFetch<{
      data: ModelRow[];
      gateway: { pricingVersion: string; pricingAgeDays: number };
    }>(`/api/v1/models${query.toString() ? `?${query.toString()}` : ''}`);
    models = result.data;
    pricingVersion = result.gateway.pricingVersion;
    pricingAgeDays = result.gateway.pricingAgeDays;
  } catch (error) {
    return (
      <>
        <PageHeader title="Models" />
        <GatewayError error={error} />
      </>
    );
  }

  const providers = [...new Set(models.map((m) => m.providerId))].sort();
  const unverified = models.some((m) => m.pricing && !m.pricing.verified);
  const unpriced = models.filter((m) => !m.pricing);

  return (
    <>
      <PageHeader
        title="Models"
        description="Every model registered on this gateway. Latency and success rate are measured from this gateway's own traffic over the last 24 hours; pricing is operator-configured."
      />

      {unverified && (
        <div className="mb-4">
          <Notice tone="warn" title="Pricing is not verified">
            The active price table is <Mono>{pricingVersion}</Mono>, last set {pricingAgeDays} day(s) ago, and is the
            placeholder set shipped with the project. Cost figures derived from it are illustrative. Publish a verified
            snapshot with <Mono>POST /api/v1/pricing/versions</Mono> before treating any cost as real.
          </Notice>
        </div>
      )}

      {unpriced.length > 0 && (
        <div className="mb-4">
          <Notice tone="info" title={`${unpriced.length} model(s) have no configured price`}>
            The gateway records no cost for these rather than guessing one, and the lowest-cost routing strategy ranks
            them last: {unpriced.slice(0, 6).map((m) => m.id).join(', ')}
            {unpriced.length > 6 && ` and ${unpriced.length - 6} more`}.
          </Notice>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchBox placeholder="Model name…" />
        <QueryFilter
          param="provider"
          label="Provider"
          options={[{ value: '', label: 'Any' }, ...providers.map((p) => ({ value: p, label: p }))]}
        />
        <QueryFilter
          param="capability"
          label="Capability"
          options={[{ value: '', label: 'Any' }, ...CAPABILITIES.map((c) => ({ value: c, label: c }))]}
        />
        <QueryFilter
          param="status"
          label="Status"
          options={[
            { value: '', label: 'Any' },
            { value: 'available', label: 'Available' },
            { value: 'degraded', label: 'Degraded' },
            { value: 'deprecated', label: 'Deprecated' },
            { value: 'disabled', label: 'Disabled' },
          ]}
        />
      </div>

      <Panel>
        {models.length === 0 ? (
          <EmptyState
            title="No models match"
            body="Register a provider, or clear the filters. A gateway with no models returns no_route_available for every request."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Model</Th>
                <Th>Provider</Th>
                <Th align="right">Context</Th>
                <Th align="right">Max out</Th>
                <Th align="right">In / M</Th>
                <Th align="right">Out / M</Th>
                <Th align="right">Reqs 24h</Th>
                <Th align="right">p95</Th>
                <Th align="right">Success</Th>
                <Th>Status</Th>
                <Th>Circuit</Th>
                <Th>Capabilities</Th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <Td>
                    <Mono className="text-zinc-200">{model.id}</Mono>
                    <div className="text-2xs text-zinc-600">{model.displayName}</div>
                  </Td>
                  <Td>
                    <Mono>{model.providerId}</Mono>
                  </Td>
                  <Td align="right">{formatNumber(model.contextWindow)}</Td>
                  <Td align="right">{model.maxOutputTokens ? formatNumber(model.maxOutputTokens) : <span className="text-zinc-600">—</span>}</Td>
                  <Td align="right">
                    {model.pricing ? (
                      <span
                        className={model.pricing.verified ? undefined : 'text-amber-300/90'}
                        title={model.pricing.verified ? model.pricing.source : `Unverified: ${model.pricing.source}`}
                      >
                        {formatCurrency(model.pricing.inputPerMillionTokens, model.pricing.currency)}
                      </span>
                    ) : (
                      <span className="text-zinc-600" title="No price configured; no cost is recorded for this model.">
                        unpriced
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    {model.pricing ? (
                      <span className={model.pricing.verified ? undefined : 'text-amber-300/90'}>
                        {formatCurrency(model.pricing.outputPerMillionTokens, model.pricing.currency)}
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </Td>
                  <Td align="right">{model.measured ? formatCompact(model.measured.requests) : <span className="text-zinc-600">0</span>}</Td>
                  <Td align="right">
                    {model.measured && model.measured.requests > 0 ? (
                      formatDuration(model.measured.p95LatencyMs)
                    ) : (
                      <span className="text-zinc-600" title="No measured traffic in the last 24 hours.">
                        —
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    {model.measured && model.measured.requests > 0 ? (
                      formatPercent(model.measured.successRate, 1)
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={model.status === 'available' ? 'success' : model.status === 'disabled' ? 'error' : 'cancelled'}>
                      {model.status}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge tone={CIRCUIT_TONES[model.circuit] ?? 'neutral'} title="Circuit breaker state for this provider and model.">
                      {model.circuit.toLowerCase().replace('_', '-')}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {model.capabilities.map((capability) => (
                        <Pill key={capability}>{capability}</Pill>
                      ))}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      <p className="mt-3 text-2xs leading-relaxed text-zinc-600">
        Health states: <Badge tone={HEALTH_TONES['healthy']!}>healthy</Badge> at or above the configured success-rate
        floor, <Badge tone={HEALTH_TONES['degraded']!}>degraded</Badge> below it but still routable,{' '}
        <Badge tone={HEALTH_TONES['unavailable']!}>unavailable</Badge> excluded from routing, and{' '}
        <Badge tone={HEALTH_TONES['unknown']!}>unknown</Badge> when there are too few samples to judge. Too few samples
        is treated as unproven, not unhealthy.
      </p>
    </>
  );
}
