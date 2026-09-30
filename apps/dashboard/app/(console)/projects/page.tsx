import Link from 'next/link';
import { formatRelativeTime } from '@ai-gateway/ui';
import {
  gatewayFetch,
  type ApiKeyRow,
  type ModelRow,
  type PolicyRow,
  type ProjectRow,
} from '@/lib/gateway';
import {
  Badge,
  EmptyState,
  PageHeader,
  Panel,
  Pill,
  Table,
  Td,
  Th,
} from '@/components/ui/primitives';
import { ActionForm } from '@/components/action-form';
import { Field, Input } from '@/components/ui/controls';
import { createProject } from '@/app/actions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Projects · AI Gateway' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  let projects: ProjectRow[] = [];
  let keys: ApiKeyRow[] = [];
  let policies: PolicyRow[] = [];
  let models: ModelRow[] = [];
  try {
    const [projectResult, keyResult, policyResult, modelResult] = await Promise.all([
      gatewayFetch<{ data: ProjectRow[] }>('/api/v1/projects'),
      gatewayFetch<{ data: ApiKeyRow[] }>('/api/v1/api-keys').catch(() => ({
        data: [] as ApiKeyRow[],
      })),
      gatewayFetch<{ data: PolicyRow[] }>('/api/v1/routing-policies').catch(() => ({
        data: [] as PolicyRow[],
      })),
      gatewayFetch<{ data: ModelRow[] }>('/api/v1/models').catch(() => ({
        data: [] as ModelRow[],
      })),
    ]);
    projects = projectResult.data;
    keys = keyResult.data;
    policies = policyResult.data;
    models = modelResult.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Projects" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project owns API keys, a routing policy, a model allowlist and its own budgets. It is the unit traffic is attributed to."
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Projects">
          {projects.length === 0 ? (
            <EmptyState
              title="No projects"
              body="Create one to group keys, policies and budgets."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th align="right">Keys</Th>
                  <Th>Routing policy</Th>
                  <Th>Allowed models</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const projectKeys = keys.filter(
                    (key) => key.projectId === project.id && key.status === 'active',
                  );
                  const policy = policies.find((p) => p.id === project.routingPolicyId);
                  return (
                    <tr key={project.id}>
                      <Td>
                        <span className="text-xs text-zinc-200">{project.name}</span>
                        <div className="font-mono text-2xs text-zinc-600">{project.slug}</div>
                        {project.archived && (
                          <Badge tone="error" className="mt-0.5">
                            archived
                          </Badge>
                        )}
                      </Td>
                      <Td align="right">{projectKeys.length}</Td>
                      <Td>
                        {policy ? (
                          <span className="text-xs text-zinc-300">
                            {policy.name}{' '}
                            <span className="text-zinc-600">v{policy.activeVersion}</span>
                          </span>
                        ) : (
                          <span className="text-2xs text-zinc-600">organization default</span>
                        )}
                      </Td>
                      <Td>
                        {project.allowedModels === null || project.allowedModels === undefined ? (
                          <span className="text-2xs text-zinc-600">
                            all {models.length} registered
                          </span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {project.allowedModels.slice(0, 3).map((model) => (
                              <Pill key={model}>{model}</Pill>
                            ))}
                            {project.allowedModels.length > 3 && (
                              <Pill>+{project.allowedModels.length - 3}</Pill>
                            )}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="text-2xs text-zinc-500">
                          {formatRelativeTime(project.createdAt)}
                        </span>
                      </Td>
                      <Td>
                        <Link
                          href={`/projects/${project.id}`}
                          className="text-xs text-accent hover:underline"
                        >
                          Manage
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Panel>

        <Panel title="Create a project">
          <div className="p-4">
            <ActionForm action={createProject} submitLabel="Create project">
              <Field label="Name">
                <Input name="name" placeholder="Production" required />
              </Field>
              <Field label="Slug" hint="Lowercase, used in URLs and CLI output.">
                <Input name="slug" placeholder="production" mono required />
              </Field>
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
