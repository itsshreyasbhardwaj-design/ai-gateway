import { GatewayError, systemClock, type Clock } from '@ai-gateway/core';
import type { AttemptRecorder, TraceBuilder } from '@ai-gateway/observability';
import { backoffDelay, isRetryable, type RetryPolicy } from './retry.js';
import type { RoutePlan, ScoredTarget } from './types.js';

export interface AttemptContext {
  target: ScoredTarget;
  /** 1-indexed across the whole request, not per target. */
  attemptNumber: number;
  /** 1-indexed within this target. */
  targetAttempt: number;
  recorder: AttemptRecorder;
  signal: AbortSignal;
}

export interface FallbackExecutorOptions<T> {
  plan: RoutePlan;
  retry: RetryPolicy;
  trace: TraceBuilder;
  signal: AbortSignal;
  clock?: Clock;
  random?: () => number;
  /** Called once per attempt. Throwing signals failure. */
  attempt: (ctx: AttemptContext) => Promise<T>;
  /** Notified before each wait, for logging. */
  onRetry?: (info: {
    target: ScoredTarget;
    delayMs: number;
    error: GatewayError;
    attemptNumber: number;
  }) => void;
  onFallback?: (info: { from: ScoredTarget; to: ScoredTarget; error: GatewayError }) => void;
}

export interface ExecutionResult<T> {
  value: T;
  target: ScoredTarget;
  attempts: number;
  fallbackUsed: boolean;
}

/**
 * Run a routing plan: retry a target while the error says retrying could help,
 * then fail over to the next target while the error says a different provider
 * could help, and give up honestly when neither is true.
 *
 * Two behaviours worth calling out:
 *
 *  - A non-failoverable error (bad request, auth, content filter, budget)
 *    aborts the whole chain immediately. Walking a fallback chain with a
 *    malformed request just multiplies the failure across providers.
 *  - Client disconnection stops everything at once. There is no one left to
 *    receive the response, so continuing would spend money for nobody.
 */
export async function executeWithFallback<T>(
  opts: FallbackExecutorOptions<T>,
): Promise<ExecutionResult<T>> {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;
  const { chain } = opts.plan;

  if (chain.length === 0) {
    throw new GatewayError('no_route_available', 'The routing plan produced no targets.');
  }

  let attemptNumber = 0;
  let lastError: GatewayError | undefined;

  for (let targetIndex = 0; targetIndex < chain.length; targetIndex++) {
    const target = chain[targetIndex]!;

    for (let targetAttempt = 1; targetAttempt <= opts.retry.maxAttempts; targetAttempt++) {
      if (opts.signal.aborted) {
        throw new GatewayError(
          'client_disconnected',
          'The client disconnected before the request completed.',
        );
      }

      attemptNumber++;
      const delayMs =
        targetAttempt === 1
          ? 0
          : backoffDelay(targetAttempt, opts.retry, lastError?.retryAfterSeconds, random);

      if (delayMs > 0) {
        opts.onRetry?.({ target, delayMs, error: lastError!, attemptNumber });
        try {
          await clock.sleep(delayMs, opts.signal);
        } catch {
          throw new GatewayError(
            'client_disconnected',
            'The client disconnected while the gateway was backing off.',
          );
        }
      }

      const recorder = opts.trace.startAttempt(
        target.target.providerId,
        target.target.modelId,
        attemptNumber,
        delayMs || undefined,
      );

      try {
        const value = await opts.attempt({
          target,
          attemptNumber,
          targetAttempt,
          recorder,
          signal: opts.signal,
        });
        // Callers that know their usage mark the attempt themselves; for the
        // rest, returning without throwing is the success signal.
        if (recorder.record.status !== 'success') recorder.succeed();
        return { value, target, attempts: attemptNumber, fallbackUsed: targetIndex > 0 };
      } catch (err) {
        const error = GatewayError.from(err);
        error.requestId ??= opts.trace.requestId;
        lastError = error;
        recorder.fail(error.type, error.message, error.providerStatus, error.retryAfterSeconds);

        if (error.type === 'client_disconnected') throw error;

        // Neither retry nor failover can help; surface it straight away.
        if (!error.retryable && !error.failoverable) throw error;

        const canRetryHere =
          isRetryable(error, opts.retry) && targetAttempt < opts.retry.maxAttempts;
        if (canRetryHere) continue;

        break; // move to the next target in the chain
      }
    }

    const next = chain[targetIndex + 1];
    if (next && lastError?.failoverable) {
      opts.onFallback?.({ from: target, to: next, error: lastError });
      continue;
    }
    if (next && lastError && !lastError.failoverable) break;
  }

  // With a single target there was no fallback to exhaust, so reporting
  // `fallback_exhausted` would hide the real cause. Surface the provider's
  // own normalized error - status code, retry-after and all - and let the
  // caller react to what actually happened.
  if (chain.length === 1 && lastError) throw lastError;

  throw new GatewayError(
    'fallback_exhausted',
    `All ${chain.length} routing targets failed. Last error (${lastError?.type ?? 'unknown'}): ${lastError?.message ?? 'unknown'}`,
    {
      requestId: opts.trace.requestId,
      cause: lastError,
      ...(lastError?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: lastError.retryAfterSeconds }
        : {}),
      details: {
        attempts: attemptNumber,
        chain: chain.map((t) => t.target.modelId),
        lastErrorType: lastError?.type,
        lastErrorProvider: lastError?.provider,
      },
    },
  );
}
