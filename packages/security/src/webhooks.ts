import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing, modelled on the scheme most payment providers use:
 * sign `<timestamp>.<body>` so a captured payload cannot be replayed later.
 */

const SCHEME = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function signWebhook(body: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},${SCHEME}=${mac}`;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'malformed' | 'timestamp_out_of_tolerance' | 'signature_mismatch';
}

export function verifyWebhook(
  body: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  const parts = Object.fromEntries(
    header
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== undefined && kv[1] !== undefined),
  );
  const ts = Number(parts['t']);
  const provided = parts[SCHEME];
  if (!Number.isFinite(ts) || !provided) return { valid: false, reason: 'malformed' };

  if (Math.abs(nowSeconds - ts) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

/** Full-jitter exponential backoff schedule for webhook delivery retries. */
export function webhookRetryDelays(attempts = 6, baseMs = 1_000, maxMs = 3_600_000): number[] {
  const delays: number[] = [];
  for (let i = 0; i < attempts; i++) {
    delays.push(Math.min(maxMs, baseMs * 2 ** i));
  }
  return delays;
}
