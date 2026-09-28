/** Injectable clock so retry/backoff, budgets and circuit breakers stay testable. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Deterministic clock for tests: time only advances when you advance it. */
export class FakeClock implements Clock {
  private current: number;
  private waiters: Array<{ at: number; resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((resolve, reject) => {
      const waiter = { at: this.current + ms, resolve, reject };
      this.waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.waiters.filter((w) => w.at <= this.current);
    this.waiters = this.waiters.filter((w) => w.at > this.current);
    for (const w of due) w.resolve();
    // Let any continuations scheduled by the resolved sleeps run.
    await new Promise((r) => setImmediate(r));
  }

  get pending(): number {
    return this.waiters.length;
  }
}
