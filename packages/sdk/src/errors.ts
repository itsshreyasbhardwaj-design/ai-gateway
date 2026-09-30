import type { ErrorBody, GatewayErrorType } from './types.js';

/** Error thrown for any non-2xx gateway response. */
export class AIGatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: ErrorBody, requestId?: string) {
    super(body.error.message);
    this.name = 'AIGatewayError';
    this.status = status;
    this.type = body.error.type;
    this.retryable = body.error.retryable;
    this.requestId = body.error.requestId ?? requestId;
    this.provider = body.error.provider;
    this.model = body.error.model;
    this.retryAfterSeconds = body.error.retryAfterSeconds;
    this.details = body.error.details;
  }

  static isAIGatewayError(e: unknown): e is AIGatewayError {
    return e instanceof AIGatewayError;
  }
}

/** Raised when the client's own deadline elapses before a response. */
export class AIGatewayTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request exceeded the client timeout of ${timeoutMs}ms.`);
    this.name = 'AIGatewayTimeoutError';
  }
}

/** Raised when the gateway cannot be reached at all. */
export class AIGatewayConnectionError extends Error {
  /** The underlying transport failure, when there was one. */
  readonly underlying?: unknown;

  constructor(message: string, underlying?: unknown) {
    super(message);
    this.name = 'AIGatewayConnectionError';
    this.underlying = underlying;
  }
}
