import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { gatewayPublicFetch, type GatewayInfo } from '@/lib/gateway';
import { Sidebar } from '@/components/nav';
import { TopBar } from '@/components/top-bar';

/**
 * Console shell.
 *
 * The gateway's self-description is fetched once per navigation and rendered in
 * the top bar, so the operator always sees which gateway they are looking at,
 * whether its store is durable, and whether its price table has been verified.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/connect');

  let info: GatewayInfo | null = null;
  let reachable = true;
  try {
    info = await gatewayPublicFetch<GatewayInfo>(session.gatewayUrl, '/');
  } catch {
    reachable = false;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar gatewayUrl={session.gatewayUrl} source={session.source} info={info} reachable={reachable} />
        <main className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
