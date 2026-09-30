import { gatewayFetch, type ModelRow } from '@/lib/gateway';
import { Notice, PageHeader } from '@/components/ui/primitives';
import { PlaygroundClient } from './playground-client';
import { GatewayError } from '../error-panel';

export const metadata = { title: 'Playground · AI Gateway' };
export const dynamic = 'force-dynamic';

export default async function PlaygroundPage() {
  let models: ModelRow[] = [];
  try {
    const result = await gatewayFetch<{ data: ModelRow[] }>('/api/v1/models');
    models = result.data;
  } catch (error) {
    return (
      <>
        <PageHeader title="Playground" />
        <GatewayError error={error} />
      </>
    );
  }

  const mockModels = models.filter(
    (model) => model.providerId === 'mock' || model.providerId.startsWith('mock'),
  );

  return (
    <>
      <PageHeader
        title="Playground"
        description="Two separate things: a routing dry-run that contacts no provider and costs nothing, and a real request that is flagged as test traffic and excluded from production analytics."
      />

      <div className="mb-4">
        <Notice tone="info" title="Test traffic is separated, not hidden">
          Requests sent from here are recorded in the request log with an{' '}
          <code className="font-mono">isTest</code> flag and a{' '}
          <code className="font-mono">playground</code> tag. They count against rate limits — a flag
          that exempted a request from the limiter would make the limiter meaningless — but never
          against a budget.
        </Notice>
      </div>

      <PlaygroundClient
        models={models.map((m) => ({
          id: m.id,
          capabilities: m.capabilities,
          providerId: m.providerId,
        }))}
        mockModels={mockModels.map((m) => m.id)}
      />
    </>
  );
}
