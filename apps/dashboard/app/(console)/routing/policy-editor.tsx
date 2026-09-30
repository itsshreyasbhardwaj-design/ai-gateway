'use client';

import dynamicImport from 'next/dynamic';
import { useState } from 'react';
import { createPolicy, validatePolicy } from '@/app/actions';
import { Button, Field, Input, Select } from '@/components/ui/controls';
import { Mono, Notice, Panel } from '@/components/ui/primitives';
import type { ProjectRow } from '@/lib/gateway';

/**
 * Monaco is loaded client-side only and with an explicit loading state: a
 * `dynamic()` import without one suspends the whole page until the editor
 * chunk arrives, which makes the rest of the screen appear broken.
 */
const MonacoEditor = dynamicImport(
  () => import('@monaco-editor/react').then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-72 items-center justify-center rounded border border-surface-border bg-surface text-xs text-zinc-600">
        Loading editor…
      </div>
    ),
  },
);

interface ValidationState {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
  warnings?: Array<{ path: string; message: string }>;
  checksum?: string;
}

export function PolicyEditor({ projects, starter }: { projects: ProjectRow[]; starter: string }) {
  const [document, setDocument] = useState(starter);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const validate = async () => {
    setBusy(true);
    setResult(null);
    const outcome = await validatePolicy(document);
    setBusy(false);
    setValidation((outcome.data as unknown as ValidationState) ?? { valid: false });
  };

  return (
    <Panel
      title="Create a policy"
      subtitle="Validated against the same parser the gateway uses at request time"
    >
      <div className="space-y-3 p-4">
        <form
          action={async (formData) => {
            setBusy(true);
            setResult(null);
            formData.set('document', document);
            const outcome = await createPolicy(formData);
            setBusy(false);
            setResult(outcome.ok ? (outcome.message ?? 'Created.') : `Failed: ${outcome.message}`);
          }}
          className="space-y-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input name="name" placeholder="production" required />
            </Field>
            <Field label="Scope" hint="Organization default, or pinned to one project.">
              <Select
                name="projectId"
                className="w-full"
                options={[
                  { value: '', label: 'Organization default' },
                  ...projects.map((project) => ({
                    value: project.id,
                    label: `${project.name} (${project.slug})`,
                  })),
                ]}
              />
            </Field>
          </div>

          <div>
            <span className="mb-1 block text-2xs font-medium uppercase tracking-wider text-zinc-500">
              Policy document (YAML)
            </span>
            <div className="overflow-hidden rounded border border-surface-border">
              <MonacoEditor
                height="340px"
                defaultLanguage="yaml"
                theme="vs-dark"
                value={document}
                onChange={(value) => {
                  setDocument(value ?? '');
                  setValidation(null);
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                  renderWhitespace: 'none',
                  padding: { top: 8, bottom: 8 },
                }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={validate} disabled={busy} size="md">
              {busy ? 'Checking…' : 'Validate'}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={busy || validation?.valid === false}
              title={validation?.valid === false ? 'Fix the validation errors first.' : undefined}
            >
              Create and activate
            </Button>
          </div>
        </form>

        {validation && (
          <div className="space-y-2">
            {validation.valid ? (
              <Notice tone="info" title="Valid">
                Checksum <Mono>{validation.checksum}</Mono>. Creating it publishes version 1 and
                activates it.
              </Notice>
            ) : (
              <Notice tone="danger" title="Invalid policy">
                <ul className="space-y-1">
                  {validation.errors?.map((issue, index) => (
                    <li key={index}>
                      {issue.path && <Mono className="text-red-200">{issue.path}</Mono>}{' '}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
            {validation.warnings && validation.warnings.length > 0 && (
              <Notice tone="warn" title="Warnings">
                <ul className="space-y-1">
                  {validation.warnings.map((issue, index) => (
                    <li key={index}>
                      {issue.path && <Mono className="text-amber-200">{issue.path}</Mono>}{' '}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}

        {result && <Notice tone={result.startsWith('Failed') ? 'danger' : 'info'}>{result}</Notice>}
      </div>
    </Panel>
  );
}
