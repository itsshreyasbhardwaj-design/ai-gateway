'use client';

import { useState } from 'react';
import { formatCurrency, formatDuration } from '@ai-gateway/ui';
import { runPlaygroundRequest, runRouteTest, simulateProviderFailure } from '@/app/actions';
import { Button, Field, Input, Select } from '@/components/ui/controls';
import { Badge, EmptyState, Mono, Notice, Panel, Pill, Table, Td, Th } from '@/components/ui/primitives';

const STRATEGIES = [
  { value: '', label: 'Policy default' },
  { value: 'explicit', label: 'Explicit (declared order)' },
  { value: 'lowest_cost', label: 'Lowest cost' },
  { value: 'lowest_latency', label: 'Lowest measured latency' },
  { value: 'highest_reliability', label: 'Highest measured reliability' },
  { value: 'weighted', label: 'Weighted' },
  { value: 'priority', label: 'Priority' },
  { value: 'round_robin', label: 'Round robin' },
  { value: 'fallback_chain', label: 'Fallback chain' },
];

const FAILURE_MODES = [
  { value: 'none', label: 'None (recover)' },
  { value: 'rate_limit', label: '429 rate limited' },
  { value: 'server_error', label: '500 server error' },
  { value: 'timeout', label: 'Timeout' },
  { value: 'overloaded', label: 'Overloaded' },
  { value: 'auth', label: 'Auth rejected' },
  { value: 'invalid_request', label: 'Invalid request' },
  { value: 'mid_stream_error', label: 'Fail mid-stream' },
];

interface RouteTestResult {
  note: string;
  strategy: string;
  requiredCapabilities: string[];
  estimatedInputTokens: number;
  selected: { provider: string; model: string; score: number; reasons: string[] } | null;
  chain: Array<{
    position: number;
    role: string;
    provider: string;
    model: string;
    score: number;
    reasons: string[];
    signals: Record<string, unknown>;
  }>;
  rejected: Array<{ target: string; reason: string }>;
  planReasons: string[];
  policy: { name: string; version: number | null };
}

interface RunResult {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { input: number; output: number; total: number; source: string };
  gateway?: {
    requestId: string;
    provider: string;
    model: string;
    strategy: string;
    attempts: number;
    fallbackUsed: boolean;
    cache: string;
    latencyMs: number;
    reasons: string[];
    estimatedCost?: { amount: number; currency: string; pricingVersion: string };
  };
}

export function PlaygroundClient({
  models,
  mockModels,
}: {
  models: Array<{ id: string; capabilities: string[]; providerId: string }>;
  mockModels: string[];
}) {
  const [routeTest, setRouteTest] = useState<RouteTestResult | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulationNote, setSimulationNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'test' | 'run' | 'simulate' | null>(null);

  const modelOptions = [
    { value: 'gateway/auto', label: 'gateway/auto (most reliable)' },
    { value: 'gateway/cheapest', label: 'gateway/cheapest' },
    { value: 'gateway/fastest', label: 'gateway/fastest' },
    ...models.map((model) => ({ value: model.id, label: model.id })),
  ];

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Panel title="Routing dry-run" subtitle="Shows the plan the router would produce. No provider is contacted.">
          <form
            action={async (formData) => {
              setBusy('test');
              setError(null);
              const result = await runRouteTest(formData);
              setBusy(null);
              if (result.ok) setRouteTest(result.data as unknown as RouteTestResult);
              else setError(result.message ?? 'Route test failed.');
            }}
            className="space-y-3 p-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model">
                <Select name="model" className="w-full" options={modelOptions} defaultValue="gateway/auto" />
              </Field>
              <Field label="Strategy override">
                <Select name="strategy" className="w-full" options={STRATEGIES} />
              </Field>
            </div>
            <Field label="Prompt" hint="Used only to size the cost projection.">
              <Input name="prompt" defaultValue="Explain this SQL query." />
            </Field>
            <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="requireTools" className="accent-accent" />
                Requires tools
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="requireVision" className="accent-accent" />
                Requires vision
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="stream" className="accent-accent" />
                Streaming
              </label>
            </div>
            <Button type="submit" variant="primary" size="md" disabled={busy !== null}>
              {busy === 'test' ? 'Planning…' : 'Run dry-run'}
            </Button>
          </form>
        </Panel>

        <Panel title="Send a real request" subtitle="Flagged as test traffic; costs money and appears in the request log.">
          <form
            action={async (formData) => {
              setBusy('run');
              setError(null);
              const result = await runPlaygroundRequest(formData);
              setBusy(null);
              if (result.ok) setRun(result.data as unknown as RunResult);
              else setError(result.message ?? 'Request failed.');
            }}
            className="space-y-3 p-4"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model">
                <Select name="model" className="w-full" options={modelOptions} defaultValue="gateway/auto" />
              </Field>
              <Field label="Strategy override">
                <Select name="strategy" className="w-full" options={STRATEGIES} />
              </Field>
            </div>
            <Field label="Prompt">
              <Input name="prompt" defaultValue="Say hello in one short sentence." required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Temperature">
                <Input name="temperature" type="number" step="0.1" min="0" placeholder="provider default" />
              </Field>
              <Field label="Max tokens">
                <Input name="maxTokens" type="number" min="1" placeholder="policy default" />
              </Field>
            </div>
            <Button type="submit" variant="primary" size="md" disabled={busy !== null}>
              {busy === 'run' ? 'Sending…' : 'Send request'}
            </Button>
          </form>
        </Panel>

        {mockModels.length > 0 && (
          <Panel
            title="Failover simulation"
            subtitle="Applies only to the synthetic mock provider. Real providers cannot be made to fail from here."
          >
            <form
              action={async (formData) => {
                setBusy('simulate');
                setError(null);
                const result = await simulateProviderFailure(formData);
                setBusy(null);
                if (result.ok) setSimulationNote(result.message ?? 'Applied.');
                else setError(result.message ?? 'Simulation failed.');
              }}
              className="space-y-3 p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Mock model">
                  <Select
                    name="model"
                    className="w-full"
                    options={mockModels.map((id) => ({ value: id, label: id }))}
                  />
                </Field>
                <Field label="Failure mode">
                  <Select name="failureMode" className="w-full" options={FAILURE_MODES} />
                </Field>
              </div>
              <Field label="Fail only the first N calls" hint="Leave empty to fail every call until reset.">
                <Input name="failFirstN" type="number" min="0" placeholder="e.g. 2" />
              </Field>
              <Button type="submit" size="md" disabled={busy !== null}>
                {busy === 'simulate' ? 'Applying…' : 'Apply to mock provider'}
              </Button>
            </form>
            {simulationNote && (
              <div className="px-4 pb-4">
                <Notice tone="warn">{simulationNote}</Notice>
              </div>
            )}
          </Panel>
        )}
      </div>

      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}

        <Panel title="Routing plan" subtitle={routeTest?.note}>
          {!routeTest ? (
            <EmptyState title="No dry-run yet" body="Run one to see which target would be chosen, and why every other candidate was not." />
          ) : (
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Pill>strategy {routeTest.strategy}</Pill>
                <Pill>policy {routeTest.policy.name}{routeTest.policy.version ? ` v${routeTest.policy.version}` : ''}</Pill>
                <Pill>~{routeTest.estimatedInputTokens} input tokens</Pill>
                {routeTest.requiredCapabilities.map((capability) => (
                  <Pill key={capability}>needs {capability}</Pill>
                ))}
              </div>

              {routeTest.selected ? (
                <div className="rounded border border-accent/30 bg-accent/[0.06] p-3">
                  <div className="flex items-center gap-2">
                    <Badge tone="success">selected</Badge>
                    <Mono className="text-zinc-100">{routeTest.selected.model}</Mono>
                    <span className="text-2xs text-zinc-500">score {routeTest.selected.score}</span>
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {routeTest.selected.reasons.map((reason, index) => (
                      <li key={index} className="text-2xs leading-relaxed text-zinc-400">
                        · {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <Notice tone="danger">No eligible target. Every candidate was excluded — see below.</Notice>
              )}

              {routeTest.chain.length > 1 && (
                <Table>
                  <thead>
                    <tr>
                      <Th align="right">#</Th>
                      <Th>Target</Th>
                      <Th align="right">Score</Th>
                      <Th>Signals</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeTest.chain.slice(1).map((entry) => (
                      <tr key={entry.model}>
                        <Td align="right">{entry.position}</Td>
                        <Td>
                          <Mono>{entry.model}</Mono>
                        </Td>
                        <Td align="right">{entry.score}</Td>
                        <Td>
                          <span className="text-2xs text-zinc-500">
                            {String(entry.signals['healthState'])} · circuit {String(entry.signals['circuit'])}
                            {entry.signals['projectedCost'] !== null &&
                              ` · ~${formatCurrency(Number(entry.signals['projectedCost']), 'USD')}`}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}

              {routeTest.rejected.length > 0 && (
                <div>
                  <p className="mb-1 text-2xs font-medium uppercase tracking-wider text-zinc-500">Excluded candidates</p>
                  <ul className="space-y-1">
                    {routeTest.rejected.map((rejection, index) => (
                      <li key={index} className="text-2xs leading-relaxed text-zinc-500">
                        <Mono className="text-red-300/80">{rejection.target}</Mono> {rejection.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Response">
          {!run ? (
            <EmptyState title="No request sent yet" />
          ) : (
            <div className="space-y-3 p-4">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-surface-border bg-surface px-3 py-2 text-xs leading-relaxed text-zinc-200">
                {run.choices?.[0]?.message?.content ?? '(no content)'}
              </pre>

              {run.gateway && (
                <div className="space-y-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mono className="text-zinc-400">{run.gateway.requestId}</Mono>
                    <Pill>{run.gateway.provider}/{run.gateway.model.split('/').pop()}</Pill>
                    <Pill>{run.gateway.strategy}</Pill>
                    <Pill>{formatDuration(run.gateway.latencyMs)}</Pill>
                    <Pill>{run.gateway.attempts} attempt(s)</Pill>
                    {run.gateway.fallbackUsed && <Badge tone="cancelled">fallback used</Badge>}
                    {run.gateway.cache !== 'miss' && <Badge tone="success">{run.gateway.cache}</Badge>}
                  </div>

                  {run.usage && (
                    <p className="text-zinc-400">
                      {run.usage.total} tokens (in {run.usage.input} / out {run.usage.output}){' '}
                      <span className={run.usage.source === 'estimated' ? 'text-amber-300' : 'text-emerald-300'}>
                        {run.usage.source === 'estimated' ? 'estimated by the gateway' : 'reported by the provider'}
                      </span>
                      {run.gateway.estimatedCost && (
                        <>
                          {' · '}
                          {formatCurrency(run.gateway.estimatedCost.amount, run.gateway.estimatedCost.currency)}
                          <span className="ml-1 text-2xs text-zinc-600">@ {run.gateway.estimatedCost.pricingVersion}</span>
                        </>
                      )}
                    </p>
                  )}

                  <ul className="space-y-0.5">
                    {run.gateway.reasons.map((reason, index) => (
                      <li key={index} className="text-2xs leading-relaxed text-zinc-500">
                        · {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
