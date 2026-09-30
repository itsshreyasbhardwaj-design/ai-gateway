'use client';

import { useState } from 'react';
import { disconnectGateway } from '@/app/actions';
import { Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/controls';
import type { GatewayInfo } from '@/lib/gateway';

export function TopBar({
  gatewayUrl,
  source,
  info,
  reachable,
}: {
  gatewayUrl: string;
  source: 'cookie' | 'environment';
  info: GatewayInfo | null;
  reachable: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <header className="shrink-0 border-b border-surface-border bg-surface-raised">
      <div className="flex h-12 items-center justify-between gap-4 px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-mono text-xs text-zinc-400">{gatewayUrl}</span>
          {reachable ? (
            <Badge tone="success">online</Badge>
          ) : (
            <Badge tone="error">unreachable</Badge>
          )}
          {info && (
            <>
              <Badge tone="neutral" title="Where the gateway persists requests, keys and policies.">
                {info.store === 'postgres' ? 'postgres' : 'in-memory'}
              </Badge>
              {!info.countersDurable && (
                <Badge tone="cancelled" title="Rate limits and spend counters are per-process. Correct for a single replica only.">
                  local counters
                </Badge>
              )}
              {!info.pricing.verified && (
                <Badge
                  tone="cancelled"
                  title={info.pricing.note ?? 'The price table has not been verified against provider price lists.'}
                >
                  unverified pricing
                </Badge>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Hide details' : 'Details'}
          </Button>
          {source === 'cookie' && (
            <form action={disconnectGateway}>
              <Button type="submit" variant="ghost">
                Disconnect
              </Button>
            </form>
          )}
        </div>
      </div>

      {expanded && info && (
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 border-t border-surface-border px-6 py-3 text-xs md:grid-cols-4">
          <Detail label="Version" value={info.version} />
          <Detail label="Providers" value={info.providers.length ? info.providers.join(', ') : 'none registered'} />
          <Detail label="Models" value={String(info.models)} />
          <Detail label="Store" value={info.store} />
          <Detail label="Pricing version" value={info.pricing.version} />
          <Detail label="Pricing age" value={`${info.pricing.ageDays} day(s)`} />
          <Detail label="Semantic cache" value={info.capabilities['semanticCache'] ? 'enabled' : 'disabled'} />
          <Detail label="Credential source" value={source === 'cookie' ? 'browser session' : 'environment'} />
          {!info.pricing.verified && info.pricing.note && (
            <p className="col-span-2 text-amber-300/90 md:col-span-4">{info.pricing.note}</p>
          )}
        </div>
      )}
    </header>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-zinc-600">{label}</span>
      <span className="truncate font-mono text-zinc-300">{value}</span>
    </div>
  );
}
