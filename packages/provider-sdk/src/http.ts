import { GatewayError, classifyHttpStatus, type GatewayErrorType } from '@ai-gateway/core';

export interface HttpClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  defaultTimeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Provider id, used to attribute errors. */
  providerId: string;
}

export interface HttpRequestOptions {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Adapters pass their own status->type mapper for vendor-specific codes. */
  classify?: (status: number, body: unknown) => GatewayErrorType | undefined;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/**
 * Minimal HTTP client shared by every adapter.
 *
 * It owns three things adapters should not each reimplement: deadline
 * enforcement, normalization of upstream failures into `GatewayError`, and
 * honouring client cancellation promptly.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly providerId: string;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = opts.headers ?? {};
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.providerId = opts.providerId;
  }

  async requestJson<T>(opts: HttpRequestOptions): Promise<HttpResponse<T>> {
    const res = await this.rawRequest(opts);
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw this.toError(res, parsed, opts.classify);
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  /** Returns the raw streaming body. The caller owns draining and cancelling it. */
  async requestStream(opts: HttpRequestOptions): Promise<Response> {
    const res = await this.rawRequest(opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep the raw text */
      }
      throw this.toError(res, parsed, opts.classify);
    }
    if (!res.body) {
      throw new GatewayError('provider_error', 'Provider returned an empty stream body.', {
        provider: this.providerId,
      });
    }
    return res;
  }

  private async rawRequest(opts: HttpRequestOptions): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (opts.signal?.aborted) controller.abort();

    try {
      return await this.fetchImpl(`${this.baseUrl}${opts.path}`, {
        method: opts.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.headers,
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) {
        throw new GatewayError(
          'provider_timeout',
          `Provider did not respond within ${timeoutMs}ms.`,
          { provider: this.providerId, cause: err },
        );
      }
      if (opts.signal?.aborted) {
        throw new GatewayError('client_disconnected', 'The client cancelled the request.', {
          provider: this.providerId,
          cause: err,
        });
      }
      throw new GatewayError('provider_unavailable', describeNetworkError(err), {
        provider: this.providerId,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private toError(
    res: Response,
    body: unknown,
    classify?: (status: number, body: unknown) => GatewayErrorType | undefined,
  ): GatewayError {
    const type = classify?.(res.status, body) ?? classifyHttpStatus(res.status, body);
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    return new GatewayError(type, providerMessage(type, this.providerId, body), {
      provider: this.providerId,
      providerStatus: res.status,
      providerCode: extractCode(body),
      retryAfterSeconds: retryAfter,
      cause: body,
    });
  }
}

/**
 * Upstream error text can contain anything, including fragments of the caller's
 * own prompt. It is kept on the trace for operators but never echoed into the
 * user-facing message.
 */
function providerMessage(type: GatewayErrorType, providerId: string, _body: unknown): string {
  switch (type) {
    case 'provider_rate_limit':
      return `Provider "${providerId}" rate limited this request.`;
    case 'provider_timeout':
      return `Provider "${providerId}" timed out.`;
    case 'provider_unavailable':
      return `Provider "${providerId}" is currently unavailable.`;
    case 'provider_overloaded':
      return `Provider "${providerId}" is overloaded.`;
    case 'authentication_error':
      return `The gateway's credential for provider "${providerId}" was rejected.`;
    case 'permission_denied':
      return `Provider "${providerId}" denied access to this model.`;
    case 'model_not_found':
      return `Provider "${providerId}" does not recognise the requested model.`;
    case 'context_length_exceeded':
      return 'The request exceeds the model context window.';
    case 'content_filter':
      return 'The provider blocked this request under its content policy.';
    case 'invalid_request':
      return `Provider "${providerId}" rejected the request as malformed.`;
    default:
      return `Provider "${providerId}" returned an error.`;
  }
}

function extractCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const err = (body as { error?: unknown }).error;
  if (err && typeof err === 'object') {
    const code =
      (err as { code?: unknown; type?: unknown }).code ?? (err as { type?: unknown }).type;
    if (typeof code === 'string') return code;
  }
  const top =
    (body as { code?: unknown; type?: unknown }).code ?? (body as { type?: unknown }).type;
  return typeof top === 'string' ? top : undefined;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return undefined;
}

function describeNetworkError(err: unknown): string {
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  if (code === 'ENOTFOUND') return 'Provider hostname could not be resolved.';
  if (code === 'ECONNREFUSED') return 'Provider refused the connection.';
  if (code === 'ECONNRESET') return 'Provider reset the connection.';
  if (code === 'CERT_HAS_EXPIRED') return "Provider's TLS certificate has expired.";
  return 'Could not reach the provider.';
}
