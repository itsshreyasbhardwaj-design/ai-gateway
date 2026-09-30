import { formatRelativeTime, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, gatewayPublicFetch, type GatewayInfo } from '@/lib/gateway';
import { getSession } from '@/lib/session';
import { Badge, KeyValue, Mono, Notice, PageHeader, Panel, Table, Td, Th } from '@/components/ui/primitives';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Settings · AI Gateway' };
export const dynamic = 'force-dynamic';

interface AuditEntry {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface PricingVersion {
  version: string;
  asOf: string;
  source: string;
  notes?: string;
  modelCount: number;
}

export default async function SettingsPage() {
  const session = await getSession();
  let info: GatewayInfo | null = null;
  let audit: AuditEntry[] = [];
  let pricing: { active: string; ageDays: number; data: PricingVersion[] } | null = null;

  try {
    info = await gatewayPublicFetch<GatewayInfo>(session!.gatewayUrl, '/');
    const [auditResult, pricingResult] = await Promise.allSettled([
      gatewayFetch<{ data: AuditEntry[] }>('/api/v1/audit-logs?limit=50'),
      gatewayFetch<{ active: string; ageDays: number; data: PricingVersion[] }>('/api/v1/pricing/versions'),
    ]);
    if (auditResult.status === 'fulfilled') audit = auditResult.value.data;
    if (pricingResult.status === 'fulfilled') pricing = pricingResult.value;
  } catch (error) {
    return (
      <>
        <PageHeader title="Settings" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="What this gateway is actually running, and what it has been asked to do. Everything here is read from the gateway, not from the dashboard's own configuration."
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel title="Gateway">
          <KeyValue label="URL">
            <Mono>{session!.gatewayUrl}</Mono>
          </KeyValue>
          <KeyValue label="Version">{info?.version ?? '—'}</KeyValue>
          <KeyValue label="Store">
            <Badge tone={info?.store === 'postgres' ? 'success' : 'cancelled'}>{info?.store ?? '—'}</Badge>
            {info?.store !== 'postgres' && (
              <span className="ml-1.5 text-2xs text-zinc-500">not durable across restarts</span>
            )}
          </KeyValue>
          <KeyValue label="Counters">
            <Badge tone={info?.countersDurable ? 'success' : 'cancelled'}>
              {info?.countersDurable ? 'redis' : 'in-process'}
            </Badge>
            {!info?.countersDurable && (
              <span className="ml-1.5 text-2xs text-zinc-500">correct for a single replica only</span>
            )}
          </KeyValue>
          <KeyValue label="Providers">{info?.providers.join(', ') || 'none registered'}</KeyValue>
          <KeyValue label="Models">{info?.models ?? 0}</KeyValue>
          <KeyValue label="Semantic cache">
            {info?.capabilities['semanticCache'] ? 'enabled' : 'disabled'}
          </KeyValue>
          <KeyValue label="Credential source">
            {session!.source === 'cookie' ? 'browser session (httpOnly cookie)' : 'dashboard environment'}
          </KeyValue>
        </Panel>

        <Panel title="Pricing">
          {!pricing ? (
            <div className="p-4">
              <Notice tone="info">Pricing versions require an admin-scoped key.</Notice>
            </div>
          ) : (
            <>
              {!info?.pricing.verified && (
                <div className="p-4 pb-0">
                  <Notice tone="warn" title="The active price table is unverified">
                    {info?.pricing.note ??
                      'These numbers are the placeholder set shipped with the project and have not been checked against provider price lists.'}{' '}
                    Publish a verified snapshot with <Mono>POST /api/v1/pricing/versions</Mono>; existing cost rows keep
                    the version they were computed with, so history does not change retroactively.
                  </Notice>
                </div>
              )}
              <Table>
                <thead>
                  <tr>
                    <Th>Version</Th>
                    <Th>As of</Th>
                    <Th>Source</Th>
                    <Th align="right">Models</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {pricing.data.map((version) => (
                    <tr key={version.version}>
                      <Td>
                        <Mono>{version.version}</Mono>
                      </Td>
                      <Td>{version.asOf}</Td>
                      <Td className="max-w-xs truncate" title={version.notes ?? version.source}>
                        <span className="text-2xs text-zinc-500">{version.source}</span>
                      </Td>
                      <Td align="right">{version.modelCount}</Td>
                      <Td>
                        {version.version === pricing.active && <Badge tone="success">active</Badge>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </Panel>

        <Panel title="Audit log" subtitle="Administrative writes, newest first" className="lg:col-span-2" scroll>
          {audit.length === 0 ? (
            <div className="p-4">
              <Notice tone="info">
                No audit entries yet, or this key lacks the <Mono>admin</Mono> scope.
              </Notice>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Resource</Th>
                  <Th>Actor</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry) => (
                  <tr key={entry.id}>
                    <Td title={formatTimestamp(entry.createdAt)}>
                      <span className="text-2xs text-zinc-500">{formatRelativeTime(entry.createdAt)}</span>
                    </Td>
                    <Td>
                      <Mono>{entry.action}</Mono>
                    </Td>
                    <Td>
                      <span className="text-2xs text-zinc-500">{entry.resourceType}</span>{' '}
                      <Mono className="text-zinc-400">{entry.resourceId}</Mono>
                    </Td>
                    <Td>
                      <Mono className="text-zinc-500">
                        {entry.actorType}:{entry.actorId}
                      </Mono>
                    </Td>
                    <Td className="max-w-md truncate">
                      {entry.metadata && (
                        <span className="font-mono text-2xs text-zinc-600" title={JSON.stringify(entry.metadata, null, 2)}>
                          {JSON.stringify(entry.metadata)}
                        </span>
                      )}
                    </Td>
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
