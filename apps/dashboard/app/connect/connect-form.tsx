'use client';

import { useState } from 'react';
import { connectGateway, probeGateway } from '@/app/actions';
import { Button, Field, Input } from '@/components/ui/controls';
import { Notice, Panel } from '@/components/ui/primitives';

export function ConnectForm({ defaultUrl }: { defaultUrl: string }) {
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Panel className="p-5">
      <form
        action={async (formData) => {
          setBusy(true);
          setError(null);
          const result = await connectGateway(formData);
          setBusy(false);
          // A successful connect redirects, so reaching here means it failed.
          if (result && !result.ok) setError(result.message ?? 'Could not connect.');
        }}
        className="space-y-4"
      >
        <Field label="Gateway URL" hint="Where the gateway service is listening.">
          <Input
            name="gatewayUrl"
            defaultValue={defaultUrl}
            mono
            placeholder="http://localhost:8787"
          />
        </Field>

        <Field
          label="Admin API key"
          hint="Needs the admin scope for provider, key and policy management. Read-only keys can still view usage and requests."
        >
          <Input name="apiKey" type="password" mono placeholder="aigw_live_…" required />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}
        {probe && <Notice tone="info">{probe}</Notice>}

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" size="md" disabled={busy}>
            {busy ? 'Verifying…' : 'Connect'}
          </Button>
          <Button
            size="md"
            onClick={async () => {
              const input = document.querySelector<HTMLInputElement>('input[name="gatewayUrl"]');
              const result = await probeGateway(input?.value ?? defaultUrl);
              setProbe(
                result.ok
                  ? `Reachable: ${String(result.data?.['service'])} v${String(result.data?.['version'])}, ${
                      (result.data?.['providers'] as string[] | undefined)?.length ?? 0
                    } provider(s), ${String(result.data?.['models'] ?? 0)} model(s).`
                  : `Not reachable: ${result.message}`,
              );
            }}
          >
            Test connection
          </Button>
        </div>
      </form>

      <p className="mt-5 border-t border-surface-border pt-4 text-2xs leading-relaxed text-zinc-600">
        Running the gateway for the first time? <code className="font-mono">pnpm dev</code> prints a
        bootstrap key once on stdout. Alternatively set{' '}
        <code className="font-mono">AI_GATEWAY_ADMIN_KEY</code> in the dashboard&apos;s environment
        to skip this screen.
      </p>
    </Panel>
  );
}
