import {
  formatCompact, formatCurrency, formatDuration, formatNumber, formatPercent,
} from '@ai-gateway/ui';
import { gatewayFetch, type ProviderComparisonRow, type UsageReport } from '@/lib/gateway';
import { EmptyState, Mono, Notice, PageHeader, Panel, Stat, Table, Td, Th } from '@/components/ui/primitives';
import { RangeTabs, Toggle } from '@/components/ui/controls';
import { CostChart, LatencyChart, RequestsChart, TokensChart } from '@/components/charts';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Usage · AI Gateway' };
export const dynamic = 'force-dynamic';

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; includeTest?: string }>;
}) {
  const params = await searchParams;
  const range = params.range ?? '24h';
  const includeTest = params.includeTest === 'true';
  const query = `range=${encodeURIComponent(range)}${includeTest ? '&includeTest=true' : ''}`;

  let usage: UsageReport;
  let comparison: ProviderComparisonRow[] = [];
  try {
    usage = await gatewayFetch<UsageReport>(`/api/v1/usage?${query}`);
    const result = await gatewayFetch<{ data: ProviderComparisonRow[] }>(`/api/v1/usage/providers?${query}`);
    comparison = result.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Usage" />
        <GatewayError error={error} />
      </>
    );
  }

  const s = usage.summary;

  return (
    <>
      <PageHeader
        title="Usage"
        description="Everything here is derived from recorded gateway requests. Costs are computed from the configured price table, not from provider invoices."
        actions={
          <div className="flex items-center gap-2">
            <Toggle
              param="includeTest"
              label="Include test traffic"
              hint="Playground and replay requests are excluded from production analytics by default."
            />
            <RangeTabs current={range} />
          </div>
        }
      />

      {includeTest && (
        <div className="mb-4">
          <Notice tone="warn" title="Test traffic included">
            Playground runs, failover simulations and replays are counted in these figures. Turn the toggle off for
            production-only numbers.
          </Notice>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Requests" value={formatNumber(s.totalRequests)} sub={`${formatNumber(s.successfulRequests)} ok · ${formatNumber(s.failedRequests)} failed · ${formatNumber(s.cancelledRequests)} cancelled`} />
        <Stat label="Tokens" value={formatCompact(s.totalTokens)} sub={`in ${formatCompact(s.inputTokens)} / out ${formatCompact(s.outputTokens)}`} />
        <Stat
          label="Estimated cost"
          value={formatCurrency(s.estimatedCost, s.currency)}
          hint={`From price table "${usage.disclosure.pricingVersion}", last verified ${usage.disclosure.pricingAgeDays} day(s) ago.`}
          sub={s.pricingVersions.length > 1 ? `spans ${s.pricingVersions.length} pricing versions` : undefined}
        />
        <Stat
          label="Time to first token"
          value={s.avgTimeToFirstTokenMs === null ? '—' : formatDuration(s.avgTimeToFirstTokenMs)}
          hint="Average across streamed responses only."
          sub={`p95 total ${formatDuration(s.p95LatencyMs)}`}
        />
      </div>

      {s.estimatedUsageShare > 0 && (
        <div className="mb-4">
          <Notice tone="warn" title="Some token counts are estimates">
            {formatPercent(s.estimatedUsageShare)} of requests in this window had their token counts approximated by
            the gateway because the provider did not report usage. Cost figures for those rows are correspondingly
            approximate. The gateway never presents an estimate as a provider-reported number.
          </Notice>
        </div>
      )}

      <div className="mb-4 grid min-w-0 gap-3 lg:grid-cols-2">
        <Panel title="Requests over time">
          <div className="px-2 pb-2 pt-3">
            <RequestsChart data={usage.series} bucketMs={usage.range.bucketMs} />
          </div>
        </Panel>
        <Panel title="Tokens over time">
          <div className="px-2 pb-2 pt-3">
            <TokensChart data={usage.series} bucketMs={usage.range.bucketMs} />
          </div>
        </Panel>
        <Panel title="Estimated cost over time">
          <div className="px-2 pb-2 pt-3">
            <CostChart data={usage.series} bucketMs={usage.range.bucketMs} currency={s.currency} />
          </div>
        </Panel>
        <Panel title="Average latency over time">
          <div className="px-2 pb-2 pt-3">
            <LatencyChart data={usage.series} bucketMs={usage.range.bucketMs} />
          </div>
        </Panel>
      </div>

      <div className="mb-4">
        <Panel
          title="Provider comparison"
          subtitle={`Raw measurements between ${usage.range.from.slice(0, 19).replace('T', ' ')} and ${usage.range.to.slice(0, 19).replace('T', ' ')} UTC. No composite score, and no ranking of model quality.`}
        >
          {comparison.length === 0 ? (
            <EmptyState title="No provider traffic in this window" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th align="right">Requests</Th>
                  <Th align="right">Success</Th>
                  <Th align="right">Errors</Th>
                  <Th align="right">p50</Th>
                  <Th align="right">p95</Th>
                  <Th align="right">p99</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Est. cost</Th>
                  <Th align="right">Cost / M tokens</Th>
                  <Th>Usage source</Th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.providerId}>
                    <Td>
                      <Mono>{row.providerId}</Mono>
                    </Td>
                    <Td align="right">{formatNumber(row.requests)}</Td>
                    <Td align="right">{formatPercent(row.successRate, 2)}</Td>
                    <Td align="right">{formatPercent(row.errorRate, 2)}</Td>
                    <Td align="right">{formatDuration(row.p50LatencyMs)}</Td>
                    <Td align="right">{formatDuration(row.p95LatencyMs)}</Td>
                    <Td align="right">{formatDuration(row.p99LatencyMs)}</Td>
                    <Td align="right">{formatCompact(row.totalTokens)}</Td>
                    <Td align="right">{formatCurrency(row.estimatedCost, s.currency)}</Td>
                    <Td align="right">
                      {row.costPerMillionTokens === null ? (
                        <span className="text-zinc-600" title="No tokens were counted for this provider in the window.">
                          —
                        </span>
                      ) : (
                        formatCurrency(row.costPerMillionTokens, s.currency)
                      )}
                    </Td>
                    <Td>
                      <span className="text-2xs text-zinc-500">
                        {row.usageSourceMix.provider_reported} reported / {row.usageSourceMix.estimated} estimated
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <BreakdownPanel title="By model" rows={usage.breakdown.model} currency={s.currency} />
        <BreakdownPanel title="By provider" rows={usage.breakdown.provider} currency={s.currency} />
        <BreakdownPanel title="By status" rows={usage.breakdown.status} currency={s.currency} />
        <BreakdownPanel
          title="By error type"
          rows={usage.breakdown.errorType}
          currency={s.currency}
          emptyLabel="No errors in this window"
        />
      </div>
    </>
  );
}

function BreakdownPanel({
  title,
  rows,
  currency,
  emptyLabel,
}: {
  title: string;
  rows: UsageReport['breakdown']['model'];
  currency: string;
  emptyLabel?: string;
}) {
  return (
    <Panel title={title} scroll>
      {rows.length === 0 ? (
        <EmptyState title={emptyLabel ?? 'No data in this window'} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Key</Th>
              <Th align="right">Requests</Th>
              <Th align="right">Errors</Th>
              <Th align="right">Tokens</Th>
              <Th align="right">Est. cost</Th>
              <Th align="right">p95</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <Td>
                  <Mono>{row.key}</Mono>
                </Td>
                <Td align="right">{formatNumber(row.requests)}</Td>
                <Td align="right" className={row.errors > 0 ? 'text-red-300' : undefined}>
                  {formatNumber(row.errors)}
                </Td>
                <Td align="right">{formatCompact(row.tokens)}</Td>
                <Td align="right">{formatCurrency(row.cost, currency)}</Td>
                <Td align="right">{formatDuration(row.p95LatencyMs)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
