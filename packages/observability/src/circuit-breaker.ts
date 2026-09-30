import { systemClock, type Clock } from '@ai-gateway/core';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** Minimum calls in the window before the failure *rate* is trusted. */
  minimumThroughput: number;
  /** Failure rate (0..1) that trips the breaker once throughput is met. */
  failureRateThreshold: number;
  /** Rolling window used for the rate calculation, in ms. */
  rollingWindowMs: number;
  /** How long the breaker stays OPEN before probing again, in ms. */
  openDurationMs: number;
  /** Probes allowed through in HALF_OPEN. */
  halfOpenProbes: number;
  /** Consecutive probe successes needed to close the breaker. */
  successThreshold: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  minimumThroughput: 10,
  failureRateThreshold: 0.5,
  rollingWindowMs: 60_000,
  openDurationMs: 30_000,
  halfOpenProbes: 2,
  successThreshold: 2,
};

interface Outcome {
  at: number;
  ok: boolean;
}

export interface CircuitSnapshot {
  key: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  windowTotal: number;
  windowFailures: number;
  failureRate: number;
  openedAt?: number;
  /** When an OPEN breaker will next allow a probe. */
  retryAt?: number;
}

/**
 * Per-target circuit breaker.
 *
 * The design point the spec calls out explicitly: a single failed request must
 * never take a provider out of rotation. Tripping requires either a run of
 * consecutive failures or a sustained failure *rate* over a minimum number of
 * calls, and recovery is probe-based rather than time-based alone.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private outcomes: Outcome[] = [];
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt?: number;
  private probesInFlight = 0;

  constructor(
    readonly key: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  /** True when a call may proceed. Transitions OPEN -> HALF_OPEN when due. */
  allow(): boolean {
    const now = this.clock.now();
    if (this.state === 'OPEN') {
      if (this.openedAt !== undefined && now - this.openedAt >= this.config.openDurationMs) {
        this.state = 'HALF_OPEN';
        this.probesInFlight = 0;
        this.consecutiveSuccesses = 0;
      } else {
        return false;
      }
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probesInFlight >= this.config.halfOpenProbes) return false;
      this.probesInFlight++;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.push(true);
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    if (this.state === 'HALF_OPEN') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (this.consecutiveSuccesses >= this.config.successThreshold) this.close();
    }
  }

  recordFailure(): void {
    this.push(false);
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    if (this.state === 'HALF_OPEN') {
      // A failed probe means the provider is still sick; back off again.
      this.open();
      return;
    }

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
      return;
    }

    const { total, failures } = this.window();
    if (
      total >= this.config.minimumThroughput &&
      failures / total >= this.config.failureRateThreshold
    ) {
      this.open();
    }
  }

  get currentState(): CircuitState {
    // Reading the state should reflect an elapsed open period without needing
    // a call to come through first.
    if (this.state === 'OPEN' && this.openedAt !== undefined) {
      if (this.clock.now() - this.openedAt >= this.config.openDurationMs) return 'HALF_OPEN';
    }
    return this.state;
  }

  snapshot(): CircuitSnapshot {
    const { total, failures } = this.window();
    return {
      key: this.key,
      state: this.currentState,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      windowTotal: total,
      windowFailures: failures,
      failureRate: total ? failures / total : 0,
      openedAt: this.openedAt,
      retryAt: this.openedAt !== undefined ? this.openedAt + this.config.openDurationMs : undefined,
    };
  }

  /** Operator override, e.g. after fixing a credential. */
  reset(): void {
    this.close();
    this.outcomes = [];
  }

  forceOpen(): void {
    this.open();
  }

  private open(): void {
    this.state = 'OPEN';
    this.openedAt = this.clock.now();
    this.probesInFlight = 0;
    this.consecutiveSuccesses = 0;
  }

  private close(): void {
    this.state = 'CLOSED';
    this.openedAt = undefined;
    this.probesInFlight = 0;
    this.consecutiveFailures = 0;
  }

  private push(ok: boolean): void {
    this.outcomes.push({ at: this.clock.now(), ok });
    this.trim();
  }

  private window(): { total: number; failures: number } {
    this.trim();
    let failures = 0;
    for (const o of this.outcomes) if (!o.ok) failures++;
    return { total: this.outcomes.length, failures };
  }

  private trim(): void {
    const cutoff = this.clock.now() - this.config.rollingWindowMs;
    while (this.outcomes.length > 0 && (this.outcomes[0]?.at ?? 0) < cutoff) this.outcomes.shift();
  }
}

/** Keyed collection of breakers, one per provider or provider/model pair. */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    private readonly clock: Clock = systemClock,
  ) {}

  get(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(key, this.config, this.clock);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  snapshots(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((b) => b.snapshot());
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) breaker.reset();
  }
}
