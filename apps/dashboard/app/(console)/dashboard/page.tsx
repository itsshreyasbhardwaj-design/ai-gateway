import Link from 'next/link';
import {
  formatCompact,
  formatCurrency,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  HEALTH_TONES,
} from '@ai-gateway/ui';
import { gatewayFetch, type ProviderRow, type RequestRow, type UsageReport } from '@/lib/gateway';
import {
  Badge,
  EmptyState,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Stat,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { RangeTabs } from '@/components/ui/controls';
import { RequestsChart, CostChart, DistributionChart } from '@/components/charts';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Overview · AI Gateway' };
export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; limitedScope?: string }>;
}) {
  const params = await searchParams;
  const range = params.range ?? '24h';

  let usage: UsageReport;
  let providers: ProviderRow[] = [];
  let recent: RequestRow[] = [];

  try {
    usage = await gatewayFetch<UsageReport>(`/api/v1/usage?range=${encodeURIComponent(range)}`);
    const [providerResult, requestResult] = await Promise.allSettled([
      gatewayFetch<{ data: ProviderRow[] }>('/api/v1/providers'),
      gatewayFetch<{ data: RequestRow[] }>('/api/v1/requests?limit=8'),
    ]);
    if (providerResult.status === 'fulfilled') providers = providerResult.value.data;
    if (requestResult.status === 'fulfilled') recent = requestResult.value.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Overview" />
        <GatewayError error={error} />
      </>
    );
  }

  const s = usage.summary;
  const hasTraffic = s.totalRequests > 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Measured over the selected window from this gateway's own traffic. ${usage.disclosure.note}`}
        actions={<RangeTabs current={range} />}
      />

      {params.limitedScope === '1' && (
        <div className="mb-4">
          <Notice tone="warn" title="Read-only key">
            This key does not have the <code className="font-mono">admin</code> scope. Usage and
            request pages work; provider, key, policy and budget management will return 403.
          </Notice>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat
          label="Requests"
          value={formatCompact(s.totalRequests)}
          sub={`${formatCompact(s.failedRequests)} failed`}
        />
        <Stat
          label="Success rate"
          value={formatPercent(s.successRate, 2)}
          tone={s.totalRequests === 0 ? 'default' : s.successRate < 0.95 ? 'warn' : 'good'}
        />
        <Stat
          label="Tokens"
          value={formatCompact(s.totalTokens)}
          sub={`in ${formatCompact(s.inputTokens)} / out ${formatCompact(s.outputTokens)}`}
        />
        <Stat
          label="Estimated cost"
          value={formatCurrency(s.estimatedCost, s.currency)}
          hint={`Computed from price table "${usage.disclosure.pricingVersion}" (${usage.disclosure.pricingAgeDays} days old). Not a provider invoice.`}
          sub={
            s.estimatedUsageShare > 0
              ? `${formatPercent(s.estimatedUsageShare)} of rows used estimated tokens`
              : undefined
          }
          tone={s.estimatedUsageShare > 0.25 ? 'warn' : 'default'}
        />
        <Stat
          label="p95 latency"
          value={formatDuration(s.p95LatencyMs)}
          sub={`avg ${formatDuration(s.avgLatencyMs)}`}
        />
        <Stat
          label="Cache / fallback"
          value={`${formatPercent(s.cacheHitRate, 0)} / ${formatPercent(s.fallbackRate, 0)}`}
          hint="Cache hit rate and the share of requests a fallback target served."
          tone={s.fallbackRate > 0.05 ? 'warn' : 'default'}
        />
      </div>

      {!hasTraffic && (
        <div className="mb-4">
          <Notice tone="info" title="No traffic in this window">
            Send a request to populate these panels:
            <pre className="mt-2 overflow-x-auto rounded bg-surface px-3 py-2 font-mono text-2xs leading-relaxed text-zinc-300">{`curl $GATEWAY_URL/v1/chat/completions \\
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gateway/auto","messages":[{"role":"user","content":"hello"}]}'`}</pre>
          </Notice>
        </div>
      )}

      <div className="mb-4 grid min-w-0 gap-3 lg:grid-cols-3">
        <Panel title="Requests" subtitle="Successful and failed, stacked" className="lg:col-span-2">
          <div className="px-2 pb-2 pt-3">
            <RequestsChart data={usage.series} bucketMs={usage.range.bucketMs} />
          </div>
        </Panel>
        <Panel title="Estimated cost" subtitle={`Price table ${usage.disclosure.pricingVersion}`}>
          <div className="px-2 pb-2 pt-3">
            <CostChart data={usage.series} bucketMs={usage.range.bucketMs} currency={s.currency} />
          </div>
        </Panel>
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-3">
        <Panel
          title="Provider health"
          subtitle="Measured from this gateway's traffic, not vendor SLAs"
        >
          {providers.length === 0 ? (
            <EmptyState
              title="No providers registered"
              body="Set a provider API key, or enable the synthetic mock provider for local development."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th>State</Th>
                  <Th align="right">Reqs</Th>
                  <Th align="right">p95</Th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => (
                  <tr key={provider.id}>
                    <Td>
                      <Mono>{provider.id}</Mono>
                    </Td>
                    <Td>
                      <Badge tone={HEALTH_TONES[provider.health.state] ?? 'neutral'}>
                        {provider.health.state}
                      </Badge>
                    </Td>
                    <Td align="right">{formatCompact(provider.health.total)}</Td>
                    <Td align="right">
                      {provider.health.total > 0
                        ? formatDuration(provider.health.p95LatencyMs)
                        : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Traffic by model">
          {usage.breakdown.model.length === 0 ? (
            <EmptyState title="No model traffic yet" />
          ) : (
            <div className="px-2 pb-2 pt-3">
              <DistributionChart data={usage.breakdown.model} />
            </div>
          )}
        </Panel>

        <Panel
          title="Recent requests"
          actions={
            <Link href="/requests" className="text-xs text-accent hover:underline">
              View all
            </Link>
          }
        >
          {recent.length === 0 ? (
            <EmptyState title="No requests recorded" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Request</Th>
                  <Th>Model</Th>
                  <Th align="right">Latency</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((request) => (
                  <tr key={request.id}>
                    <Td>
                      <Link
                        href={`/requests/${request.id}`}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {request.id.slice(0, 16)}…
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1">
                        <Badge
                          tone={
                            request.status === 'success'
                              ? 'success'
                              : request.status === 'error'
                                ? 'error'
                                : 'cancelled'
                          }
                        >
                          {request.status}
                        </Badge>
                        <span className="text-2xs text-zinc-600">
                          {formatRelativeTime(request.createdAt)}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <Mono>{request.resolvedModelId ?? request.requestedModel}</Mono>
                    </Td>
                    <Td align="right">{formatDuration(request.latencyMs)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
