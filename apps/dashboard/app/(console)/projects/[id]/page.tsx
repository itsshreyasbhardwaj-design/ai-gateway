import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatCompact, formatCurrency, formatPercent, formatTimestamp } from '@ai-gateway/ui';
import {
  gatewayFetch, type ApiKeyRow, type ModelRow, type PolicyRow, type ProjectRow, type UsageReport,
} from '@/lib/gateway';
import { Badge, EmptyState, KeyValue, Mono, Notice, PageHeader, Panel, Pill, Stat, Table, Td, Th } from '@/components/ui/primitives';
import { ActionForm } from '@/components/action-form';
import { Field, Input } from '@/components/ui/controls';
import { updateProjectModels } from '@/app/actions';
import { GatewayError } from '../../error-panel';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let project: ProjectRow | undefined;
  let keys: ApiKeyRow[] = [];
  let policies: PolicyRow[] = [];
  let models: ModelRow[] = [];
  let usage: UsageReport | null = null;

  try {
    const [projectResult, keyResult, policyResult, modelResult] = await Promise.all([
      gatewayFetch<{ data: ProjectRow[] }>('/api/v1/projects'),
      gatewayFetch<{ data: ApiKeyRow[] }>(`/api/v1/api-keys?projectId=${encodeURIComponent(id)}`).catch(() => ({ data: [] as ApiKeyRow[] })),
      gatewayFetch<{ data: PolicyRow[] }>('/api/v1/routing-policies').catch(() => ({ data: [] as PolicyRow[] })),
      gatewayFetch<{ data: ModelRow[] }>('/api/v1/models').catch(() => ({ data: [] as ModelRow[] })),
    ]);
    project = projectResult.data.find((candidate) => candidate.id === id);
    keys = keyResult.data;
    policies = policyResult.data;
    models = modelResult.data;
    usage = await gatewayFetch<UsageReport>(`/api/v1/usage?range=7d&projectId=${encodeURIComponent(id)}`).catch(() => null);
  } catch (error) {
    return (
      <>
        <PageHeader title="Project" />
        <GatewayError error={error} />
      </>
    );
  }

  if (!project) notFound();

  const policy = policies.find((candidate) => candidate.id === project.routingPolicyId);
  const s = usage?.summary;

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            <Mono>{project.slug}</Mono> · <Mono className="text-zinc-600">{project.id}</Mono>
          </>
        }
        actions={
          <Link
            href="/projects"
            className="rounded border border-surface-border bg-surface-overlay px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            All projects
          </Link>
        }
      />

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Requests (7d)" value={formatCompact(s.totalRequests)} sub={`${formatCompact(s.failedRequests)} failed`} />
          <Stat label="Success rate" value={formatPercent(s.successRate, 2)} />
          <Stat label="Tokens (7d)" value={formatCompact(s.totalTokens)} />
          <Stat
            label="Estimated cost (7d)"
            value={formatCurrency(s.estimatedCost, s.currency)}
            hint="From the configured price table, not a provider invoice."
          />
        </div>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel title="Configuration">
          <KeyValue label="Routing policy">
            {policy ? (
              <Link href="/routing" className="text-accent hover:underline">
                {policy.name} v{policy.activeVersion}
              </Link>
            ) : (
              <span className="text-zinc-500">organization default</span>
            )}
          </KeyValue>
          <KeyValue label="Model allowlist">
            {project.allowedModels === null || project.allowedModels === undefined
              ? `every registered model (${models.length})`
              : `${project.allowedModels.length} model(s)`}
          </KeyValue>
          <KeyValue label="Denied models">
            {project.deniedModels && project.deniedModels.length > 0 ? (
              <span className="flex flex-wrap justify-end gap-1">
                {project.deniedModels.map((model) => (
                  <Pill key={model}>{model}</Pill>
                ))}
              </span>
            ) : (
              <span className="text-zinc-500">none</span>
            )}
          </KeyValue>
          <KeyValue label="Created">{formatTimestamp(project.createdAt)}</KeyValue>
          <KeyValue label="Status">
            {project.archived ? <Badge tone="error">archived</Badge> : <Badge tone="success">active</Badge>}
          </KeyValue>
        </Panel>

        <Panel title="Model allowlist">
          <div className="p-4">
            <Notice tone="info" title="Deny always beats allow">
              An allowlist here narrows the organization&apos;s; it cannot widen it. A request for a model outside the
              list is refused with <Mono>403 MODEL_NOT_ALLOWED</Mono> rather than being routed elsewhere.
            </Notice>
            <ActionForm action={updateProjectModels} submitLabel="Save allowlist" className="mt-4">
              <input type="hidden" name="projectId" value={project.id} />
              <Field
                label="Allowed models"
                hint="Space or comma separated. Leave empty to permit every registered model."
              >
                <Input
                  name="allowedModels"
                  mono
                  defaultValue={(project.allowedModels ?? []).join(' ')}
                  placeholder="openai/gpt-4o-mini anthropic/claude-haiku-4"
                />
              </Field>
            </ActionForm>
            <details className="mt-4">
              <summary className="cursor-pointer text-2xs uppercase tracking-wider text-zinc-500">
                Registered models ({models.length})
              </summary>
              <div className="mt-2 flex flex-wrap gap-1">
                {models.map((model) => (
                  <Pill key={model.id}>{model.id}</Pill>
                ))}
              </div>
            </details>
          </div>
        </Panel>

        <Panel title="API keys" className="lg:col-span-2">
          {keys.length === 0 ? (
            <EmptyState
              title="No keys for this project"
              body={<Link href="/api-keys" className="text-accent hover:underline">Create one</Link>}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Key</Th>
                  <Th>Scopes</Th>
                  <Th>Status</Th>
                  <Th>Last used</Th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <Td>
                      <span className="text-xs text-zinc-200">{key.name}</span>
                      <div className="font-mono text-2xs text-zinc-600">{key.prefix}…</div>
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Pill key={scope}>{scope}</Pill>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={key.status === 'active' ? 'success' : 'error'}>{key.status}</Badge>
                    </Td>
                    <Td>
                      <span className="text-2xs text-zinc-500">
                        {key.lastUsedAt ? formatTimestamp(key.lastUsedAt) : 'never'}
                      </span>
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
