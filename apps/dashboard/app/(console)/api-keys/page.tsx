import { formatRelativeTime, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, type ApiKeyRow, type ProjectRow } from '@/lib/gateway';
import { Badge, EmptyState, Mono, Notice, PageHeader, Panel, Pill, Table, Td, Th } from '@/components/ui/primitives';
import { ActionForm, RowAction } from '@/components/action-form';
import { Field, Input, Select } from '@/components/ui/controls';
import { createApiKey, revokeApiKey, rotateApiKey } from '@/app/actions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'API keys · AI Gateway' };
export const dynamic = 'force-dynamic';

const SCOPES = [
  { value: 'models.read', label: 'models.read — list models' },
  { value: 'inference.create', label: 'inference.create — send requests' },
  { value: 'usage.read', label: 'usage.read — read analytics' },
  { value: 'logs.read', label: 'logs.read — read request traces' },
  { value: 'admin', label: 'admin — full management (implies all)' },
];

export default async function ApiKeysPage() {
  let keys: ApiKeyRow[] = [];
  let projects: ProjectRow[] = [];
  try {
    const [keyResult, projectResult] = await Promise.all([
      gatewayFetch<{ data: ApiKeyRow[] }>('/api/v1/api-keys'),
      gatewayFetch<{ data: ProjectRow[] }>('/api/v1/projects'),
    ]);
    keys = keyResult.data;
    projects = projectResult.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="API keys" />
        <GatewayError error={error} />
      </>
    );
  }

  const active = keys.filter((key) => key.status === 'active');

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys are stored as salted scrypt hashes with a peppered lookup index. The full secret is shown exactly once, at creation, and cannot be recovered afterwards."
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Keys" subtitle={`${active.length} active of ${keys.length} total`}>
          {keys.length === 0 ? (
            <EmptyState title="No API keys" body="Create one to send requests through the gateway." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Project</Th>
                  <Th>Scopes</Th>
                  <Th>Status</Th>
                  <Th>Created</Th>
                  <Th>Last used</Th>
                  <Th>Expires</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className={key.status !== 'active' ? 'opacity-50' : undefined}>
                    <Td>
                      <span className="text-xs text-zinc-200">{key.name}</span>
                      <div className="font-mono text-2xs text-zinc-500">{key.prefix}…</div>
                      {key.rotatedFrom && (
                        <div className="text-2xs text-zinc-600" title={`Replaced ${key.rotatedFrom}`}>
                          rotated
                        </div>
                      )}
                    </Td>
                    <Td>
                      <Mono>{projects.find((p) => p.id === key.projectId)?.slug ?? key.projectId}</Mono>
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Pill key={scope} className={scope === 'admin' ? 'bg-amber-500/15 text-amber-300' : undefined}>
                            {scope}
                          </Pill>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={key.status === 'active' ? 'success' : key.status === 'revoked' ? 'error' : 'cancelled'}>
                        {key.status}
                      </Badge>
                    </Td>
                    <Td title={formatTimestamp(key.createdAt)}>
                      <span className="text-2xs text-zinc-500">{formatRelativeTime(key.createdAt)}</span>
                    </Td>
                    <Td title={key.lastUsedAt ? formatTimestamp(key.lastUsedAt) : undefined}>
                      <span className="text-2xs text-zinc-500">
                        {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : 'never'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-2xs text-zinc-500">
                        {key.expiresAt ? formatTimestamp(key.expiresAt).slice(0, 10) : 'no expiry'}
                      </span>
                    </Td>
                    <Td>
                      {key.status === 'active' && (
                        <span className="flex items-center gap-1">
                          <RowAction
                            action={rotateApiKey} arg={key.id}
                            label="Rotate"
                            confirmLabel="Confirm — revokes this key now"
                            title="Mint a replacement and revoke this key immediately."
                          />
                          <RowAction
                            action={revokeApiKey} arg={key.id}
                            label="Revoke"
                            confirmLabel="Confirm revoke"
                            variant="ghost"
                          />
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Create a key">
          <div className="p-4">
            <Notice tone="warn" title="Rotation revokes immediately">
              There is no overlap window. If you need one, create a second key, migrate traffic to it, then revoke the
              first.
            </Notice>

            <ActionForm action={createApiKey} submitLabel="Create key" secretLabel="Your new API key" className="mt-4">
              <Field label="Name" hint="What this key is for, e.g. 'production web app'.">
                <Input name="name" placeholder="production web app" required />
              </Field>
              <Field label="Project">
                <Select
                  name="projectId"
                  className="w-full"
                  options={projects.map((project) => ({ value: project.id, label: `${project.name} (${project.slug})` }))}
                />
              </Field>
              <Field label="Environment" hint="Test keys are prefixed aigw_test_ and are easy to spot in a log.">
                <Select
                  name="environment"
                  className="w-full"
                  defaultValue="live"
                  options={[
                    { value: 'live', label: 'live' },
                    { value: 'test', label: 'test' },
                  ]}
                />
              </Field>
              <div>
                <span className="mb-1 block text-2xs font-medium uppercase tracking-wider text-zinc-500">Scopes</span>
                <div className="space-y-1.5">
                  {SCOPES.map((scope) => (
                    <label key={scope.value} className="flex items-start gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        name="scopes"
                        value={scope.value}
                        defaultChecked={scope.value === 'models.read' || scope.value === 'inference.create'}
                        className="mt-0.5 accent-accent"
                      />
                      <span className="font-mono text-2xs">{scope.label}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1.5 text-2xs leading-relaxed text-zinc-600">
                  Scopes are enforced server-side on every request; they cannot be widened by the caller.
                </p>
              </div>
              <Field label="Expires" hint="Optional. An expired key is refused with the same 401 as an unknown one.">
                <Input name="expiresAt" type="date" />
              </Field>
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
