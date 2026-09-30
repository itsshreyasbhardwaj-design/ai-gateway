import { ConnectForm } from './connect-form';
import { defaultGatewayUrl } from '@/lib/session';

export const metadata = { title: 'Connect · AI Gateway' };

export default function ConnectPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
      <div className="mb-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">AI Gateway</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Connect to a gateway</h1>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          The dashboard is a client of the gateway&apos;s admin API rather than a second reader of
          its database, so it can point at a local or a remote gateway. Paste an API key with the{' '}
          <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-2xs">admin</code> scope —
          the gateway prints one on first boot. It is stored in an httpOnly cookie and never sent to
          the browser.
        </p>
      </div>
      <ConnectForm defaultUrl={defaultGatewayUrl()} />
    </main>
  );
}
