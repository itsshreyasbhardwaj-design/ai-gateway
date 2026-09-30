'use client';

import { useState, type ReactNode } from 'react';
import type { ActionResult } from '@/app/actions';
import { Button, CopyButton } from '@/components/ui/controls';
import { Notice } from '@/components/ui/primitives';

/**
 * Form wrapper for a server action.
 *
 * Centralises three things every mutation screen needs and would otherwise
 * duplicate: a pending state, an inline error, and one-time display of a secret
 * the gateway will never show again.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  secretLabel,
  className,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  secretLabel?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className={className}>
      <form
        action={async (formData) => {
          setBusy(true);
          setResult(null);
          setResult(await action(formData));
          setBusy(false);
        }}
        className="space-y-3"
      >
        {children}
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          {busy ? (pendingLabel ?? 'Working…') : submitLabel}
        </Button>
      </form>

      {result && !result.ok && (
        <div className="mt-3">
          <Notice tone="danger">{result.message}</Notice>
        </div>
      )}

      {result?.ok && result.secret && (
        <div className="mt-3">
          <Notice tone="warn" title={secretLabel ?? 'Copy this now'}>
            <p className="mb-2">{result.message}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded bg-surface px-2 py-1.5 font-mono text-2xs text-zinc-200">
                {result.secret}
              </code>
              <CopyButton value={result.secret} />
            </div>
          </Notice>
        </div>
      )}

      {result?.ok && !result.secret && result.message && (
        <div className="mt-3">
          <Notice tone="info">{result.message}</Notice>
        </div>
      )}
    </div>
  );
}

/**
 * A button that runs a server action against one row.
 *
 * The action and its argument are passed separately rather than as a closure:
 * a Server Component can only hand a Client Component a module-level
 * `'use server'` function, never an inline arrow that captures the row.
 */
export function RowAction<A extends string | undefined = undefined>({
  action,
  arg,
  label,
  confirmLabel,
  variant = 'default',
  title,
}: {
  /** A module-level server action, or (inside a Client Component) any thunk. */
  action: (arg: A) => Promise<ActionResult>;
  arg?: A;
  label: string;
  confirmLabel?: string;
  variant?: 'default' | 'danger' | 'ghost' | 'primary';
  title?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (message) return <span className="text-2xs text-zinc-400">{message}</span>;

  const run = async () => {
    setBusy(true);
    const result = await action(arg as A);
    setBusy(false);
    setMessage(result.ok ? (result.message ?? 'Done.') : `Failed: ${result.message}`);
  };

  if (confirmLabel && !confirming) {
    return (
      <Button variant={variant} title={title} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        variant={confirmLabel ? 'danger' : variant}
        disabled={busy}
        onClick={run}
        title={title}
      >
        {busy ? '…' : (confirmLabel ?? label)}
      </Button>
      {confirming && (
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      )}
    </span>
  );
}
