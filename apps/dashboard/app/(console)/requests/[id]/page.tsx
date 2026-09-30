import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatCompact, formatCurrency, formatDuration, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, GatewayRequestError, type RequestTraceResponse } from '@/lib/gateway';
import {
  Badge,
  KeyValue,
  Mono,
  Notice,
  PageHeader,
  Panel,
  Pill,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { ReplayButton } from './replay-button';
import { GatewayError } from '../../error-panel';

export const dynamic = 'force-dynamic';

const STEP_LABELS: Record<string, string> = {
  request_received: 'Request received',
  authentication: 'Authentication',
  rate_limit: 'Rate limit',
  policy_evaluation: 'Policy evaluation',
  budget_check: 'Budget check',
  cache_lookup: 'Cache lookup',
  routing: 'Routing',
  provider_request: 'Provider request',
  provider_response: 'Provider response',
  usage_extraction: 'Usage extraction',
  cache_write: 'Cache write',
  response_sent: 'Response sent',
};

export default async function RequestTracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let trace: RequestTraceResponse;
  try {
    trace = await gatewayFetch<RequestTraceResponse>(`/api/v1/requests/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof GatewayRequestError && error.status === 404) notFound();
    return (
      <>
        <PageHeader title="Request trace" />
        <GatewayError error={error} />
      </>
    );
  }

  const r = trace.request;
  const totalProviderMs = trace.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
  const overheadMs = Math.max(0, r.latencyMs - totalProviderMs);

  return (
    <>
      <PageHeader
        title="Request trace"
        description={
          <>
            <Mono className="text-zinc-300">{r.id}</Mono>
            <span className="ml-2 text-zinc-600">{formatTimestamp(r.createdAt)} UTC</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/requests"
              className="rounded border border-surface-border bg-surface-overlay px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Back to requests
            </Link>
            <ReplayButton requestId={r.id} bodyStored={trace.privacy.bodyStored} />
          </div>
        }
      />

      <div className="mb-4 grid min-w-0 gap-3 lg:grid-cols-3">
        <Panel title="Outcome">
          <KeyValue label="Status">
            <Badge
              tone={
                r.status === 'success' ? 'success' : r.status === 'error' ? 'error' : 'cancelled'
              }
            >
              {r.status}
            </Badge>
            {r.errorType && <Mono className="ml-1.5 text-red-300">{r.errorType}</Mono>}
          </KeyValue>
          <KeyValue label="HTTP status">{r.httpStatus}</KeyValue>
          {r.errorMessage && (
            <KeyValue label="Error">
              <span className="text-red-300/90">{r.errorMessage}</span>
            </KeyValue>
          )}
          <KeyValue label="Endpoint">
            <Mono>{r.endpoint}</Mono>
          </KeyValue>
          <KeyValue label="Streamed">{r.streamed ? 'yes' : 'no'}</KeyValue>
          {r.isTest && (
            <KeyValue label="Classification">
              <Badge tone="cancelled">test traffic</Badge>
            </KeyValue>
          )}
          {r.tags && r.tags.length > 0 && (
            <KeyValue label="Tags">
              <span className="flex flex-wrap justify-end gap-1">
                {r.tags.map((tag) => (
                  <Pill key={tag}>{tag}</Pill>
                ))}
              </span>
            </KeyValue>
          )}
        </Panel>

        <Panel title="Routing">
          <KeyValue label="Requested">
            <Mono>{r.requestedModel}</Mono>
          </KeyValue>
          <KeyValue label="Served by">
            {r.resolvedModelId ? (
              <Mono>{r.resolvedModelId}</Mono>
            ) : (
              <span className="text-zinc-600">not routed</span>
            )}
          </KeyValue>
          <KeyValue label="Provider">
            {r.resolvedProviderId ? (
              <Mono>{r.resolvedProviderId}</Mono>
            ) : (
              <span className="text-zinc-600">—</span>
            )}
          </KeyValue>
          <KeyValue label="Strategy">{r.strategy ?? '—'}</KeyValue>
          <KeyValue label="Attempts">
            {r.attemptCount}
            {r.fallbackUsed && (
              <Badge tone="cancelled" className="ml-1.5">
                fallback used
              </Badge>
            )}
          </KeyValue>
          <KeyValue label="Cache">
            {r.cacheStatus}
            {r.cacheSimilarity !== undefined && (
              <span className="ml-1 text-zinc-500">({r.cacheSimilarity.toFixed(4)})</span>
            )}
          </KeyValue>
        </Panel>

        <Panel title="Cost and timing">
          <KeyValue label="Total latency">{formatDuration(r.latencyMs)}</KeyValue>
          <KeyValue label="Provider time">{formatDuration(totalProviderMs)}</KeyValue>
          <KeyValue label="Gateway overhead">
            <span title="Total latency minus time spent inside provider calls.">
              {formatDuration(overheadMs)}
            </span>
          </KeyValue>
          {r.timeToFirstTokenMs !== undefined && (
            <KeyValue label="Time to first token">{formatDuration(r.timeToFirstTokenMs)}</KeyValue>
          )}
          <KeyValue label="Tokens">
            {r.usage ? (
              <>
                {formatCompact(r.usage.total)}
                <span className="ml-1 text-zinc-500">
                  (in {formatCompact(r.usage.input)} / out {formatCompact(r.usage.output)})
                </span>
              </>
            ) : (
              '—'
            )}
          </KeyValue>
          <KeyValue label="Usage source">
            {r.usage ? (
              <Badge tone={r.usage.source === 'estimated' ? 'cancelled' : 'success'}>
                {r.usage.source === 'estimated' ? 'estimated' : 'provider reported'}
              </Badge>
            ) : (
              '—'
            )}
          </KeyValue>
          <KeyValue label="Estimated cost">
            {formatCurrency(r.estimatedCost, r.currency ?? 'USD')}
            {r.pricingVersion && (
              <span className="ml-1 text-2xs text-zinc-600">@ {r.pricingVersion}</span>
            )}
          </KeyValue>
        </Panel>
      </div>

      {r.routingReasons && r.routingReasons.length > 0 && (
        <div className="mb-4">
          <Panel
            title="Why this route"
            subtitle="Recorded at decision time, not reconstructed afterwards"
          >
            <ul className="space-y-1 px-4 py-3">
              {r.routingReasons.map((reason, index) => (
                <li key={index} className="flex gap-2 text-xs leading-relaxed text-zinc-300">
                  <span className="select-none text-zinc-600">•</span>
                  {reason}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}

      <div className="mb-4">
        <Panel title="Timeline" subtitle="Every pipeline stage, in order, with its duration">
          <Table>
            <thead>
              <tr>
                <Th>Step</Th>
                <Th>Status</Th>
                <Th align="right">Duration</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {trace.steps.map((step, index) => (
                <tr key={`${step.name}-${index}`}>
                  <Td>{STEP_LABELS[step.name] ?? step.name}</Td>
                  <Td>
                    <Badge
                      tone={
                        step.status === 'ok'
                          ? 'success'
                          : step.status === 'skipped'
                            ? 'neutral'
                            : 'error'
                      }
                    >
                      {step.status}
                    </Badge>
                    {step.errorType && (
                      <Mono className="ml-1.5 text-red-300/80">{step.errorType}</Mono>
                    )}
                  </Td>
                  <Td align="right">
                    {step.durationMs === 0 ? (
                      <span className="text-zinc-600">&lt;1ms</span>
                    ) : (
                      formatDuration(step.durationMs)
                    )}
                  </Td>
                  <Td className="max-w-xl truncate">
                    {step.message && <span className="text-xs text-zinc-400">{step.message}</span>}
                    {step.detail && (
                      <span
                        className="font-mono text-2xs text-zinc-500"
                        title={JSON.stringify(step.detail, null, 2)}
                      >
                        {summarizeDetail(step.detail)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      </div>

      <div className="mb-4">
        <Panel
          title="Provider attempts"
          subtitle="Each upstream call, including retries and fallbacks, with the backoff that preceded it"
        >
          {trace.attempts.length === 0 ? (
            <p className="px-4 py-6 text-xs text-zinc-500">
              No provider was contacted. The request was answered from cache or refused before
              dispatch.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th align="right">#</Th>
                  <Th>Provider</Th>
                  <Th>Model</Th>
                  <Th>Result</Th>
                  <Th align="right">Duration</Th>
                  <Th align="right">TTFT</Th>
                  <Th align="right">Backoff</Th>
                  <Th align="right">Upstream status</Th>
                  <Th align="right">Tokens</Th>
                </tr>
              </thead>
              <tbody>
                {trace.attempts.map((attempt) => (
                  <tr key={attempt.id}>
                    <Td align="right">{attempt.attemptNumber}</Td>
                    <Td>
                      <Mono>{attempt.providerId}</Mono>
                    </Td>
                    <Td>
                      <Mono>{attempt.modelId}</Mono>
                    </Td>
                    <Td>
                      {attempt.status === 'success' ? (
                        <Badge tone="success">success</Badge>
                      ) : (
                        <Badge
                          tone={attempt.status === 'cancelled' ? 'cancelled' : 'error'}
                          title={attempt.errorMessage}
                        >
                          {attempt.errorType ?? attempt.status}
                        </Badge>
                      )}
                    </Td>
                    <Td align="right">{formatDuration(attempt.durationMs)}</Td>
                    <Td align="right">
                      {attempt.timeToFirstTokenMs === undefined ? (
                        <span className="text-zinc-600">—</span>
                      ) : (
                        formatDuration(attempt.timeToFirstTokenMs)
                      )}
                    </Td>
                    <Td align="right">
                      {attempt.backoffMs ? (
                        formatDuration(attempt.backoffMs)
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </Td>
                    <Td align="right">
                      {attempt.providerStatus ?? <span className="text-zinc-600">—</span>}
                    </Td>
                    <Td align="right">
                      {attempt.usage ? (
                        formatCompact(attempt.usage.input + attempt.usage.output)
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="Request body" subtitle={trace.privacy.note}>
        {trace.body?.request ? (
          <div className="p-4">
            <div className="mb-2 flex items-center gap-2 text-2xs text-zinc-500">
              <span>
                retention mode <Mono>{trace.privacy.mode}</Mono>
              </span>
              <span>·</span>
              <span>expires {formatTimestamp(trace.body.expiresAt)}</span>
            </div>
            <pre className="max-h-96 overflow-auto rounded border border-surface-border bg-surface px-3 py-2 font-mono text-2xs leading-relaxed text-zinc-300">
              {JSON.stringify(trace.body.request, null, 2)}
            </pre>
          </div>
        ) : (
          <div className="p-4">
            <Notice tone="info" title="No body stored">
              The organization&apos;s prompt retention mode is{' '}
              <Mono>{trace.privacy.mode ?? 'unknown'}</Mono>, so no request or response body was
              persisted for this request. Metadata, routing decisions and token counts are still
              recorded.
            </Notice>
          </div>
        )}
      </Panel>
    </>
  );
}

/** Compact one-line rendering of a step's detail object. */
function summarizeDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      parts.push(`${key}=${value.length <= 3 ? JSON.stringify(value) : `[${value.length} items]`}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}={…}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join('  ');
}
