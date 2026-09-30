/**
 * Normalized error taxonomy.
 *
 * Every provider failure is mapped onto one of these before it leaves the
 * gateway, so callers can branch on `error.type` without knowing which vendor
 * actually served (or refused) the request.
 */
export type GatewayErrorType =
  // Caller's fault - never retried, never failed over.
  | 'invalid_request'
  | 'authentication_error'
  | 'permission_denied'
  | 'model_not_allowed'
  | 'model_not_found'
  | 'policy_violation'
  | 'budget_exceeded'
  | 'rate_limit'
  | 'context_length_exceeded'
  | 'content_filter'
  | 'capability_unsupported'
  | 'payload_too_large'
  // Provider-side - candidates for retry and/or fallback.
  | 'provider_rate_limit'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_overloaded'
  | 'provider_error'
  | 'circuit_open'
  // Gateway-side.
  | 'no_route_available'
  | 'fallback_exhausted'
  | 'client_disconnected'
  | 'internal_error';

interface ErrorTrait {
  status: number;
  /** Safe to re-send the identical request to the *same* provider. */
  retryable: boolean;
  /** Safe to re-send the identical request to a *different* provider/model. */
  failoverable: boolean;
}

const TRAITS: Record<GatewayErrorType, ErrorTrait> = {
  invalid_request: { status: 400, retryable: false, failoverable: false },
  authentication_error: { status: 401, retryable: false, failoverable: false },
  permission_denied: { status: 403, retryable: false, failoverable: false },
  model_not_allowed: { status: 403, retryable: false, failoverable: false },
  model_not_found: { status: 404, retryable: false, failoverable: false },
  policy_violation: { status: 403, retryable: false, failoverable: false },
  budget_exceeded: { status: 402, retryable: false, failoverable: false },
  rate_limit: { status: 429, retryable: false, failoverable: false },
  context_length_exceeded: { status: 400, retryable: false, failoverable: false },
  content_filter: { status: 400, retryable: false, failoverable: false },
  capability_unsupported: { status: 400, retryable: false, failoverable: false },
  payload_too_large: { status: 413, retryable: false, failoverable: false },

  provider_rate_limit: { status: 429, retryable: true, failoverable: true },
  provider_timeout: { status: 504, retryable: true, failoverable: true },
  provider_unavailable: { status: 503, retryable: true, failoverable: true },
  provider_overloaded: { status: 503, retryable: true, failoverable: true },
  provider_error: { status: 502, retryable: true, failoverable: true },
  circuit_open: { status: 503, retryable: false, failoverable: true },

  no_route_available: { status: 503, retryable: false, failoverable: false },
  fallback_exhausted: { status: 502, retryable: false, failoverable: false },
  client_disconnected: { status: 499, retryable: false, failoverable: false },
  internal_error: { status: 500, retryable: false, failoverable: false },
};

export interface GatewayErrorOptions {
  /** Provider the failure came from, when there was one. */
  provider?: string;
  model?: string;
  requestId?: string;
  /** Raw HTTP status the provider returned, before normalization. */
  providerStatus?: number;
  /** Provider's own error code, kept for debugging. Never shown to end users verbatim. */
  providerCode?: string;
  /** Seconds the provider asked us to wait, parsed from `retry-after`. */
  retryAfterSeconds?: number;
  cause?: unknown;
  /** Extra non-sensitive context surfaced in the trace. */
  details?: Record<string, unknown>;
}

/** Wire representation returned to API callers. */
export interface GatewayErrorBody {
  error: {
    type: GatewayErrorType;
    message: string;
    requestId?: string;
    retryable: boolean;
    param?: string;
    provider?: string;
    model?: string;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  };
}

export class GatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly status: number;
  readonly retryable: boolean;
  readonly failoverable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;
  requestId?: string;

  constructor(type: GatewayErrorType, message: string, opts: GatewayErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'GatewayError';
    this.type = type;
    const trait = TRAITS[type];
    this.status = trait.status;
    this.retryable = trait.retryable;
    this.failoverable = trait.failoverable;
    this.provider = opts.provider;
    this.model = opts.model;
    this.requestId = opts.requestId;
    this.providerStatus = opts.providerStatus;
    this.providerCode = opts.providerCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.details = opts.details;
  }

  toBody(): GatewayErrorBody {
    const error: GatewayErrorBody['error'] = {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.requestId) error.requestId = this.requestId;
    if (this.provider) error.provider = this.provider;
    if (this.model) error.model = this.model;
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds;
    if (this.details) error.details = this.details;
    return { error };
  }

  static is(e: unknown): e is GatewayError {
    return e instanceof GatewayError;
  }

  /** Coerce anything thrown inside the pipeline into a GatewayError. */
  static from(e: unknown, fallbackType: GatewayErrorType = 'internal_error'): GatewayError {
    if (GatewayError.is(e)) return e;
    if (e instanceof Error) {
      if (e.name === 'AbortError' || e.message === 'aborted') {
        return new GatewayError(
          'client_disconnected',
          'The client disconnected before the request completed.',
          { cause: e },
        );
      }
      return new GatewayError(fallbackType, e.message, { cause: e });
    }
    return new GatewayError(fallbackType, String(e), { cause: e });
  }
}

export function statusForErrorType(type: GatewayErrorType): number {
  return TRAITS[type].status;
}

export function isRetryable(type: GatewayErrorType): boolean {
  return TRAITS[type].retryable;
}

export function isFailoverable(type: GatewayErrorType): boolean {
  return TRAITS[type].failoverable;
}

/**
 * Map a provider HTTP status onto the normalized taxonomy.
 * Adapters refine this with vendor-specific error codes where they have them.
 */
export function classifyHttpStatus(status: number, body?: unknown): GatewayErrorType {
  if (status === 400) return classify400(body);
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'provider_timeout';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'invalid_request';
  if (status === 429) return 'provider_rate_limit';
  if (status === 502 || status === 503) return 'provider_unavailable';
  if (status === 504) return 'provider_timeout';
  if (status === 529) return 'provider_overloaded';
  if (status >= 500) return 'provider_error';
  return 'provider_error';
}

function classify400(body: unknown): GatewayErrorType {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  const lowered = text.toLowerCase();
  if (
    lowered.includes('context length') ||
    lowered.includes('context_length') ||
    lowered.includes('too many tokens')
  ) {
    return 'context_length_exceeded';
  }
  if (
    lowered.includes('content filter') ||
    lowered.includes('content_filter') ||
    lowered.includes('safety')
  ) {
    return 'content_filter';
  }
  return 'invalid_request';
}
