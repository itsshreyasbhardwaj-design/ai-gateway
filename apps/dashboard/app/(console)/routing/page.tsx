import { formatRelativeTime, formatTimestamp } from '@ai-gateway/ui';
import { gatewayFetch, type PolicyRow, type ProjectRow } from '@/lib/gateway';
import { Badge, EmptyState, Mono, Notice, PageHeader, Panel, Pill, Table, Td, Th } from '@/components/ui/primitives';
import { PolicyEditor } from './policy-editor';
import { PolicyVersions } from './policy-versions';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Routing · AI Gateway' };
export const dynamic = 'force-dynamic';

const STARTER_POLICY = `name: production
description: Reliability-first, with two fallbacks and conservative retries.

routing:
  strategy: highest_reliability
  models:
    - mock/mock-fast
    - mock/mock-smart

fallback:
  enabled: true
  maxTargets: 3

retry:
  maxAttempts: 3
  initialDelayMs: 250
  maxDelayMs: 8000
  backoff: exponential
  jitter: full
  respectRetryAfter: true

cache:
  mode: off
  ttlSeconds: 3600
  similarityThreshold: 0.95

limits:
  maxOutputTokens: 16384
  timeoutMs: 120000
  allowStreaming: true
  allowTools: true
`;

export default async function RoutingPage() {
  let policies: PolicyRow[] = [];
  let projects: ProjectRow[] = [];
  try {
    const [policyResult, projectResult] = await Promise.all([
      gatewayFetch<{ data: PolicyRow[] }>('/api/v1/routing-policies'),
      gatewayFetch<{ data: ProjectRow[] }>('/api/v1/projects').catch(() => ({ data: [] as ProjectRow[] })),
    ]);
    policies = policyResult.data;
    projects = projectResult.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Routing" />
        <GatewayError error={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Routing policies"
        description="Policies are immutable versions. Publishing a version and activating it are separate steps, so editing a policy is never the same act as deploying it."
      />

      <div className="mb-4">
        <Notice tone="info" title="How a policy is chosen for a request">
          The project&apos;s assigned policy wins; otherwise the organization default; otherwise a generated policy that
          routes across every registered model. A project pointing at a policy with no active version is an error rather
          than a silent fall-through to defaults.
        </Notice>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Policies">
            {policies.length === 0 ? (
              <EmptyState
                title="No policies defined"
                body="Without one, the gateway routes across every registered model using the reliability strategy. Create a policy to pin models, ordering, retries and caching."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Policy</Th>
                    <Th>Scope</Th>
                    <Th>Strategy</Th>
                    <Th>Chain</Th>
                    <Th align="right">Active</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => {
                    const doc = policy.activeVersionDetail?.document as
                      | { routing?: { strategy?: string; models?: Array<string | { model: string }> }; cache?: { mode?: string } }
                      | undefined;
                    const models = (doc?.routing?.models ?? []).map((entry) =>
                      typeof entry === 'string' ? entry : entry.model,
                    );
                    return (
                      <tr key={policy.id}>
                        <Td>
                          <span className="text-xs text-zinc-200">{policy.name}</span>
                          <div className="font-mono text-2xs text-zinc-600">{policy.id}</div>
                        </Td>
                        <Td>
                          {policy.projectId ? (
                            <Mono title="Applies to one project.">{policy.projectId}</Mono>
                          ) : (
                            <Badge tone="neutral">org default</Badge>
                          )}
                        </Td>
                        <Td>
                          <Pill>{doc?.routing?.strategy ?? '—'}</Pill>
                          {doc?.cache?.mode && doc.cache.mode !== 'off' && (
                            <Badge tone="success" className="ml-1.5">
                              cache {doc.cache.mode}
                            </Badge>
                          )}
                        </Td>
                        <Td className="max-w-xs truncate" title={models.join(' → ')}>
                          <Mono>{models.join(' → ') || '—'}</Mono>
                        </Td>
                        <Td align="right">v{policy.activeVersion}</Td>
                        <Td title={formatTimestamp(policy.updatedAt)}>
                          <span className="text-2xs text-zinc-500">{formatRelativeTime(policy.updatedAt)}</span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>

          {policies.map((policy) => (
            <PolicyVersions key={policy.id} policyId={policy.id} policyName={policy.name} activeVersion={policy.activeVersion} />
          ))}
        </div>

        <PolicyEditor projects={projects} starter={STARTER_POLICY} />
      </div>
    </>
  );
}
