import { formatRelativeTime } from '@ai-gateway/ui';
import { gatewayFetch } from '@/lib/gateway';
import { Badge, Mono, Panel, Table, Td, Th } from '@/components/ui/primitives';
import { ActivateVersion } from './activate-version';

interface VersionRow {
  id: string;
  version: number;
  checksum: string;
  createdBy: string;
  createdAt: string;
  note?: string | null;
  active: boolean;
  document: Record<string, unknown>;
}

/** Version history for one policy, with one-click activation and rollback. */
export async function PolicyVersions({
  policyId,
  policyName,
  activeVersion,
}: {
  policyId: string;
  policyName: string;
  activeVersion: number;
}) {
  let versions: VersionRow[] = [];
  try {
    const result = await gatewayFetch<{ data: VersionRow[] }>(
      `/api/v1/routing-policies/${encodeURIComponent(policyId)}/versions`,
    );
    versions = result.data;
  } catch {
    return null;
  }

  if (versions.length <= 1) return null;

  return (
    <Panel
      title={`${policyName} · version history`}
      subtitle="Activating an earlier version is a rollback. Nothing is edited in place."
    >
      <Table>
        <thead>
          <tr>
            <Th align="right">Version</Th>
            <Th>Strategy</Th>
            <Th>Checksum</Th>
            <Th>Author</Th>
            <Th>Created</Th>
            <Th>Note</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {[...versions].reverse().map((version) => {
            const doc = version.document as { routing?: { strategy?: string } };
            return (
              <tr key={version.id}>
                <Td align="right">
                  v{version.version}
                  {version.active && (
                    <Badge tone="success" className="ml-1.5">
                      live
                    </Badge>
                  )}
                </Td>
                <Td>
                  <Mono>{doc.routing?.strategy ?? '—'}</Mono>
                </Td>
                <Td>
                  <Mono className="text-zinc-500">{version.checksum}</Mono>
                </Td>
                <Td>
                  <Mono className="text-zinc-500">{version.createdBy}</Mono>
                </Td>
                <Td title={version.createdAt}>
                  <span className="text-2xs text-zinc-500">{formatRelativeTime(version.createdAt)}</span>
                </Td>
                <Td className="max-w-xs truncate">
                  <span className="text-2xs text-zinc-500">{version.note ?? '—'}</span>
                </Td>
                <Td>
                  {!version.active && (
                    <ActivateVersion
                      policyId={policyId}
                      version={version.version}
                      isRollback={version.version < activeVersion}
                    />
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}
