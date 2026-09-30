import Link from 'next/link';
import { formatCompact, formatCurrency, formatDuration, formatRelativeTime } from '@ai-gateway/ui';
import { gatewayFetch, type ProviderRow, type RequestRow } from '@/lib/gateway';
import {
  Badge,
  EmptyState,
  Mono,
  PageHeader,
  Panel,
  Pill,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { QueryFilter, SearchBox, Toggle } from '@/components/ui/controls';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Requests · AI Gateway' };
export const dynamic = 'force-dynamic';

const STATUS_TONES = { success: 'success', error: 'error', cancelled: 'cancelled' } as const;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const query = new URLSearchParams({ limit: '50' });
  for (const key of [
    'status',
    'providerId',
    'modelId',
    'search',
    'cursor',
    'includeTest',
  ] as const) {
    const value = params[key];
    if (value) query.set(key, value);
  }

  let result: { data: RequestRow[]; nextCursor?: string };
  let providers: ProviderRow[] = [];
  try {
    result = await gatewayFetch<{ data: RequestRow[]; nextCursor?: string }>(
      `/api/v1/requests?${query.toString()}`,
    );
    const providerResult = await gatewayFetch<{ data: ProviderRow[] }>('/api/v1/providers').catch(
      () => ({ data: [] }),
    );
    providers = providerResult.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Requests" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Requests"
        description="Every request the gateway handled, with the routing decision, token usage and estimated cost. Open one for its full trace."
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchBox placeholder="Request id, model, error…" />
        <QueryFilter
          param="status"
          label="Status"
          options={[
            { value: '', label: 'Any' },
            { value: 'success', label: 'Success' },
            { value: 'error', label: 'Error' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
        <QueryFilter
          param="providerId"
          label="Provider"
          options={[
            { value: '', label: 'Any' },
            ...providers.map((p) => ({ value: p.id, label: p.id })),
          ]}
        />
        <Toggle
          param="includeTest"
          label="Include test traffic"
          hint="Playground, simulation and replay requests."
        />
      </div>

      <Panel>
        {result.data.length === 0 ? (
          <EmptyState
            title="No requests match"
            body="Adjust the filters, or send a request through the gateway to populate this log."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>When</Th>
                <Th>Status</Th>
                <Th>Routed to</Th>
                <Th>Requested</Th>
                <Th align="right">Latency</Th>
                <Th align="right">TTFT</Th>
                <Th align="right">Tokens</Th>
                <Th align="right">Est. cost</Th>
                <Th>Cache</Th>
                <Th>Attempts</Th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((request) => (
                <tr key={request.id}>
                  <Td>
                    <Link
                      href={`/requests/${request.id}`}
                      className="font-mono text-xs text-accent hover:underline"
                    >
                      {request.id}
                    </Link>
                    {request.isTest && (
                      <Badge
                        tone="cancelled"
                        className="ml-1.5"
                        title="Excluded from production analytics."
                      >
                        test
                      </Badge>
                    )}
                  </Td>
                  <Td title={request.createdAt}>
                    <span className="text-xs text-zinc-500">
                      {formatRelativeTime(request.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONES[request.status]}>{request.status}</Badge>
                    {request.errorType && (
                      <Mono className="ml-1.5 text-red-300/80" title={request.errorMessage}>
                        {request.errorType}
                      </Mono>
                    )}
                  </Td>
                  <Td>
                    {request.resolvedModelId ? (
                      <Mono>{request.resolvedModelId}</Mono>
                    ) : (
                      <span className="text-zinc-600">not routed</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-2xs text-zinc-500">{request.requestedModel}</span>
                    {request.strategy && <Pill className="ml-1.5">{request.strategy}</Pill>}
                  </Td>
                  <Td align="right">{formatDuration(request.latencyMs)}</Td>
                  <Td align="right">
                    {request.timeToFirstTokenMs === undefined ? (
                      <span className="text-zinc-600">—</span>
                    ) : (
                      formatDuration(request.timeToFirstTokenMs)
                    )}
                  </Td>
                  <Td align="right">
                    {request.usage ? (
                      <span
                        className={
                          request.usage.source === 'estimated' ? 'text-amber-300' : undefined
                        }
                        title={
                          request.usage.source === 'estimated'
                            ? 'Estimated by the gateway; the provider did not report usage.'
                            : 'Reported by the provider.'
                        }
                      >
                        {formatCompact(request.usage.total)}
                        {request.usage.source === 'estimated' && '~'}
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </Td>
                  <Td align="right">
                    {formatCurrency(request.estimatedCost, request.currency ?? 'USD')}
                  </Td>
                  <Td>
                    {request.cacheStatus === 'miss' || request.cacheStatus === 'disabled' ? (
                      <span className="text-2xs text-zinc-600">{request.cacheStatus}</span>
                    ) : (
                      <Badge
                        tone="success"
                        title={
                          request.cacheSimilarity
                            ? `similarity ${request.cacheSimilarity.toFixed(4)}`
                            : undefined
                        }
                      >
                        {request.cacheStatus.replace('_', ' ')}
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <span className="tabular text-xs">{request.attemptCount}</span>
                    {request.fallbackUsed && (
                      <Badge
                        tone="cancelled"
                        className="ml-1.5"
                        title="A fallback target served this request."
                      >
                        fallback
                      </Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>

      {result.nextCursor && (
        <div className="mt-3 flex justify-center">
          <Link
            href={`/requests?${new URLSearchParams({ ...cleanParams(params), cursor: result.nextCursor }).toString()}`}
            className="rounded border border-surface-border bg-surface-overlay px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Load older requests
          </Link>
        </div>
      )}
    </>
  );
}

function cleanParams(params: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'cursor',
    ),
  );
}
