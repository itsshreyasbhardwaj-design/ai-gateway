import {
  newAttemptId,
  systemClock,
  type Clock,
  type GatewayErrorType,
  type MeasuredUsage,
  type RequestAttempt,
  type RequestStatus,
  type TraceStep,
  type TraceStepName,
  type TraceStepStatus,
} from '@ai-gateway/core';

export interface OpenStep {
  end(detail?: Record<string, unknown>): void;
  fail(errorType: GatewayErrorType, message?: string, detail?: Record<string, unknown>): void;
  skip(reason: string): void;
}

/**
 * Accumulates the per-request timeline the dashboard renders.
 *
 * The gateway's stated contract is that nothing about routing is hidden, so
 * every stage that can change the outcome - auth, policy, budget, cache,
 * routing, each provider attempt - opens a step here, and the whole timeline is
 * persisted alongside the request row.
 */
export class TraceBuilder {
  private steps: TraceStep[] = [];
  private attempts: RequestAttempt[] = [];
  readonly startedAt: number;

  constructor(
    readonly requestId: string,
    private readonly clock: Clock = systemClock,
  ) {
    this.startedAt = clock.now();
  }

  /** Record a step that took no measurable time. */
  mark(name: TraceStepName, status: TraceStepStatus = 'ok', detail?: Record<string, unknown>): void {
    this.steps.push({
      name,
      status,
      startedAt: this.clock.now(),
      durationMs: 0,
      ...(detail ? { detail } : {}),
    });
  }

  step(name: TraceStepName): OpenStep {
    const startedAt = this.clock.now();
    const index = this.steps.length;
    this.steps.push({ name, status: 'ok', startedAt, durationMs: 0 });

    const finish = (status: TraceStepStatus, extra: Partial<TraceStep>) => {
      const step = this.steps[index];
      if (!step) return;
      step.status = status;
      step.durationMs = this.clock.now() - startedAt;
      Object.assign(step, extra);
    };

    return {
      end: (detail) => finish('ok', detail ? { detail } : {}),
      fail: (errorType, message, detail) => finish('error', { errorType, message, ...(detail ? { detail } : {}) }),
      skip: (reason) => finish('skipped', { message: reason }),
    };
  }

  startAttempt(providerId: string, modelId: string, attemptNumber: number, backoffMs?: number): AttemptRecorder {
    const startedAt = this.clock.now();
    const attempt: RequestAttempt = {
      id: newAttemptId(),
      requestId: this.requestId,
      attemptNumber,
      providerId,
      modelId,
      startedAt,
      durationMs: 0,
      status: 'error',
      ...(backoffMs !== undefined ? { backoffMs } : {}),
    };
    this.attempts.push(attempt);

    return {
      firstToken: () => {
        if (attempt.timeToFirstTokenMs === undefined) {
          attempt.timeToFirstTokenMs = this.clock.now() - startedAt;
        }
      },
      succeed: (usage?: MeasuredUsage) => {
        attempt.status = 'success';
        attempt.durationMs = this.clock.now() - startedAt;
        if (usage) attempt.usage = usage;
      },
      fail: (errorType: GatewayErrorType, message: string, providerStatus?: number, retryAfterSeconds?: number) => {
        attempt.status = errorType === 'client_disconnected' ? 'cancelled' : 'error';
        attempt.durationMs = this.clock.now() - startedAt;
        attempt.errorType = errorType;
        attempt.errorMessage = message;
        if (providerStatus !== undefined) attempt.providerStatus = providerStatus;
        if (retryAfterSeconds !== undefined) attempt.httpRetryAfterSeconds = retryAfterSeconds;
      },
      updateUsage: (usage: MeasuredUsage) => {
        attempt.usage = usage;
      },
      get record() {
        return attempt;
      },
    };
  }

  get elapsedMs(): number {
    return this.clock.now() - this.startedAt;
  }

  /**
   * Latency the gateway itself added: total elapsed minus time spent inside
   * provider calls. Reported separately so operators can tell a slow model from
   * a slow gateway.
   */
  overheadMs(): number {
    const providerTime = this.attempts.reduce((sum, a) => sum + a.durationMs, 0);
    return Math.max(0, this.elapsedMs - providerTime);
  }

  get attemptCount(): number {
    return this.attempts.length;
  }

  /** True when a target other than the first one served the request. */
  fallbackUsed(): boolean {
    const successful = this.attempts.find((a) => a.status === 'success');
    const first = this.attempts[0];
    if (!successful || !first) return false;
    return successful.providerId !== first.providerId || successful.modelId !== first.modelId;
  }

  finishedStatus(): RequestStatus {
    const last = this.attempts.at(-1);
    if (this.attempts.some((a) => a.status === 'success')) return 'success';
    if (last?.status === 'cancelled') return 'cancelled';
    return 'error';
  }

  snapshot(): { steps: TraceStep[]; attempts: RequestAttempt[] } {
    return { steps: [...this.steps], attempts: this.attempts.map((a) => ({ ...a })) };
  }
}

export interface AttemptRecorder {
  firstToken(): void;
  succeed(usage?: MeasuredUsage): void;
  fail(errorType: GatewayErrorType, message: string, providerStatus?: number, retryAfterSeconds?: number): void;
  updateUsage(usage: MeasuredUsage): void;
  readonly record: RequestAttempt;
}
