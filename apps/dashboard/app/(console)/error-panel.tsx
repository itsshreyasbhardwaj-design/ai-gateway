import { GatewayRequestError, NotConnectedError } from '@/lib/gateway';
import { Notice } from '@/components/ui/primitives';

/**
 * Render a gateway failure as something actionable.
 *
 * A dashboard that shows an empty table when the gateway is unreachable is
 * actively misleading - it looks like "no traffic" rather than "no connection".
 */
export function GatewayError({ error }: { error: unknown }) {
  if (error instanceof NotConnectedError) {
    return (
      <Notice tone="warn" title="Not connected">
        No gateway credential is configured. Visit <code className="font-mono">/connect</code> to
        add one.
      </Notice>
    );
  }
  if (error instanceof GatewayRequestError) {
    if (error.status === 0) {
      return (
        <Notice tone="danger" title="Gateway unreachable">
          {error.message} This is a connection failure, not an absence of data.
        </Notice>
      );
    }
    if (error.status === 403) {
      return (
        <Notice tone="warn" title="Insufficient scope">
          {error.message} Connect with a key that has the required scope to view this page.
        </Notice>
      );
    }
    return (
      <Notice tone="danger" title={`Gateway error (${error.status})`}>
        {error.message}
        {error.requestId && (
          <span className="ml-1 font-mono text-2xs opacity-70">request {error.requestId}</span>
        )}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" title="Unexpected error">
      {(error as Error).message}
    </Notice>
  );
}
