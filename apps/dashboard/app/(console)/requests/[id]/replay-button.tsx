'use client';

import { useState } from 'react';
import { replayRequest } from '@/app/actions';
import { Button } from '@/components/ui/controls';

/**
 * Replay control.
 *
 * Two deliberate frictions: it is disabled when no body was retained (so the
 * reason is visible rather than a surprise 400), and it requires a second click
 * to confirm. Replay costs money and must never be something a stray click does.
 */
export function ReplayButton({
  requestId,
  bodyStored,
}: {
  requestId: string;
  bodyStored: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!bodyStored) {
    return (
      <Button
        disabled
        title="Replay needs the stored request body. The organization's prompt retention mode does not keep one."
      >
        Replay unavailable
      </Button>
    );
  }

  if (result) {
    return <span className="text-2xs text-zinc-400">{result}</span>;
  }

  if (!confirming) {
    return (
      <Button
        onClick={() => setConfirming(true)}
        title="Re-send this exact request through the pipeline."
      >
        Replay
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <span className="text-2xs text-amber-300">Sends a real request and costs money.</span>
      <Button
        variant="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const outcome = await replayRequest(requestId);
          setBusy(false);
          setResult(outcome.ok ? (outcome.message ?? 'Replayed.') : `Failed: ${outcome.message}`);
        }}
      >
        {busy ? 'Replaying…' : 'Confirm replay'}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}
