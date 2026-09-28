import { GatewayError, type GatewayErrorType } from '@ai-gateway/core';

export interface RetryPolicy {
  /** Total attempts against a single target, including the first. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoff: 'exponential' | 'linear' | 'constant';
  /** Multiplier for exponential backoff. */
  factor: number;
  /** Jitter strategy. `full` is the default because it is what actually breaks up retry storms. */
  jitter: 'none' | 'full' | 'equal';
  /** Error types that may be retried against the same target. */
  retryableErrors: GatewayErrorType[];
  /** Cap on the total time spent retrying one target, in ms. */
  maxElapsedMs?: number;
  /** Honour a provider's `retry-after` even when it exceeds maxDelayMs. */
  respectRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 8_000,
  backoff: 'exponential',
  factor: 2,
  jitter: 'full',
  retryableErrors: [
    'provider_timeout',
    'provider_unavailable',
    'provider_overloaded',
    'provider_error',
    'provider_rate_limit',
  ],
  respectRetryAfter: true,
};

export const NO_RETRY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 };

/**
 * Decide whether an error may be retried against the same target.
 *
 * The rule the spec is emphatic about: a malformed request, an auth failure or
 * a policy rejection is never retried. Retrying those cannot succeed, and doing
 * it at gateway scale is how a provider's rate limits get exhausted by traffic
 * that was always going to fail.
 */
export function isRetryable(error: unknown, policy: RetryPolicy): boolean {
  if (!GatewayError.is(error)) return false;
  if (!error.retryable) return false;
  return policy.retryableErrors.includes(error.type);
}

/** Delay before attempt number `attempt` (1-indexed; attempt 1 never waits). */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  if (attempt <= 1) return 0;

  if (policy.respectRetryAfter && retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    // The provider told us exactly when to come back. Believe it, but still add
    // jitter so a fleet of gateways does not resume in lockstep.
    const base = retryAfterSeconds * 1000;
    return Math.round(base + random() * Math.min(1_000, base * 0.1));
  }

  const step = attempt - 1;
  let base: number;
  switch (policy.backoff) {
    case 'constant':
      base = policy.initialDelayMs;
      break;
    case 'linear':
      base = policy.initialDelayMs * step;
      break;
    case 'exponential':
    default:
      base = policy.initialDelayMs * policy.factor ** (step - 1);
      break;
  }

  const capped = Math.min(base, policy.maxDelayMs);
  switch (policy.jitter) {
    case 'none':
      return Math.round(capped);
    case 'equal':
      return Math.round(capped / 2 + random() * (capped / 2));
    case 'full':
    default:
      return Math.round(random() * capped);
  }
}

/** Full schedule of delays, for docs, tests and the retry-policy preview UI. */
export function backoffSchedule(policy: RetryPolicy, random: () => number = () => 1): number[] {
  return Array.from({ length: policy.maxAttempts }, (_, i) => backoffDelay(i + 1, policy, undefined, random));
}
