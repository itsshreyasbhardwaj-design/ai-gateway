import { AIGatewayConnectionError, AIGatewayError, AIGatewayTimeoutError } from './errors.js';
import { ChatCompletionStream } from './stream.js';
import type {
  ChatCompletion,
  ChatCompletionCreateParams,
  EmbeddingsCreateParams,
  EmbeddingsResponse,
  ErrorBody,
  ModelList,
} from './types.js';

export interface AIGatewayOptions {
  apiKey: string;
  /** Defaults to `AI_GATEWAY_URL` or `http://localhost:8787`. */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 120000. */
  timeoutMs?: number;
  /** Retries for connection-level and 5xx failures. Default 2. */
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Override the client's retry count for this call. */
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'http://localhost:8787';

/**
 * Client for AI Gateway.
 *
 * The surface mirrors the OpenAI SDK closely enough that migrating is usually a
 * base-URL change, with the gateway's additions available under `gateway` on
 * requests and responses.
 *
 * Client-side retries are deliberately conservative: the gateway already retries
 * and fails over server-side with proper backoff, so retrying here too would
 * multiply load. Only connection failures and 5xx responses the gateway marked
 * retryable are retried, and a 429 is never retried without its retry-after.
 */
export class AIGateway {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AIGatewayOptions) {
    if (!options.apiKey) {
      throw new Error('AIGateway requires an apiKey. Pass it explicitly or read it from AI_GATEWAY_API_KEY.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? readEnv('AI_GATEWAY_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Construct from the environment: AI_GATEWAY_API_KEY and AI_GATEWAY_URL. */
  static fromEnv(overrides: Partial<AIGatewayOptions> = {}): AIGateway {
    const apiKey = overrides.apiKey ?? readEnv('AI_GATEWAY_API_KEY');
    if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is not set.');
    return new AIGateway({ ...overrides, apiKey });
  }

  readonly chat = {
    completions: {
      /** Non-streaming completion. */
      create: (params: ChatCompletionCreateParams & { stream?: false }, options?: RequestOptions) =>
        this.post<ChatCompletion>('/v1/chat/completions', { ...params, stream: false }, options),

      /** Streaming completion. Returns an async-iterable stream. */
      stream: (params: ChatCompletionCreateParams, options?: RequestOptions) =>
        this.postStream('/v1/chat/completions', { ...params, stream: true }, options),
    },
  };

  readonly embeddings = {
    create: (params: EmbeddingsCreateParams, options?: RequestOptions) =>
      this.post<EmbeddingsResponse>('/v1/embeddings', params, options),
  };

  readonly models = {
    /** Models this key is permitted to use, with capability and pricing metadata. */
    list: (options?: RequestOptions) => this.get<ModelList>('/v1/models', options),

    retrieve: async (modelId: string, options?: RequestOptions) => {
      const list = await this.models.list(options);
      const found = list.data.find((m) => m.id === modelId);
      if (!found) {
        throw new Error(`Model "${modelId}" is not available to this API key.`);
      }
      return found;
    },
  };

  /** Current rate-limit state, so a client can pace itself without probing for 429s. */
  readonly limits = {
    retrieve: (options?: RequestOptions) =>
      this.get<{
        object: 'list';
        data: Array<{
          rule: string; subject: string; unit: string; window: string;
          limit: number; used: number; remaining: number; resetAt: number;
        }>;
      }>('/v1/limits', options),
  };

  /** Dry-run the router: returns the plan without contacting any provider. */
  readonly routing = {
    test: (
      params: {
        model: string;
        prompt?: string;
        strategy?: string;
        candidates?: string[];
        maxTokens?: number;
        stream?: boolean;
        requireTools?: boolean;
        requireVision?: boolean;
      },
      options?: RequestOptions,
    ) => this.post<RouteTestResult>('/api/v1/playground/route-test', params, options),
  };

  readonly usage = {
    retrieve: (
      query: { range?: '1h' | '24h' | '7d' | '30d' | '90d'; projectId?: string; includeTest?: boolean } = {},
      options?: RequestOptions,
    ) => {
      const search = new URLSearchParams();
      if (query.range) search.set('range', query.range);
      if (query.projectId) search.set('projectId', query.projectId);
      if (query.includeTest) search.set('includeTest', 'true');
      const qs = search.toString();
      return this.get<UsageResponse>(`/api/v1/usage${qs ? `?${qs}` : ''}`, options);
    },
  };

  readonly requests = {
    list: (
      query: Record<string, string | number | boolean | undefined> = {},
      options?: RequestOptions,
    ) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      return this.get<{ object: 'list'; data: unknown[]; nextCursor?: string }>(
        `/api/v1/requests${qs ? `?${qs}` : ''}`,
        options,
      );
    },

    /** Full trace: every step, every attempt, with timings. */
    retrieve: (requestId: string, options?: RequestOptions) =>
      this.get<RequestTrace>(`/api/v1/requests/${encodeURIComponent(requestId)}`, options),
  };

  // ------------------------------------------------------------ transport

  private async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  private async post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const maxRetries = options?.maxRetries ?? this.maxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoff(attempt, lastError));
      try {
        const response = await this.send(method, path, body, options);
        if (response.ok) return (await response.json()) as T;

        const error = await this.toError(response);
        // Only retry what the gateway itself says is retryable, and never a
        // request the caller got wrong.
        if (attempt < maxRetries && shouldRetry(error)) {
          lastError = error;
          continue;
        }
        throw error;
      } catch (err) {
        if (err instanceof AIGatewayError || err instanceof AIGatewayTimeoutError) throw err;
        lastError = err;
        if (attempt >= maxRetries) {
          throw new AIGatewayConnectionError(
            `Could not reach the AI Gateway at ${this.baseUrl}: ${(err as Error).message}`,
            err,
          );
        }
      }
    }

    throw new AIGatewayConnectionError(`Could not reach the AI Gateway at ${this.baseUrl}.`, lastError);
  }

  private async postStream(path: string, body: unknown, options?: RequestOptions): Promise<ChatCompletionStream> {
    const controller = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const response = await this.send('POST', path, body, { ...options, signal: controller.signal }, true);
    if (!response.ok) throw await this.toError(response);
    if (!response.body) {
      throw new AIGatewayConnectionError('The gateway returned a streaming response with no body.');
    }
    return new ChatCompletionStream(
      response.body,
      response.headers.get('x-request-id') ?? undefined,
      controller,
    );
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options?: RequestOptions,
    streaming = false,
  ): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const external = options?.signal;
    const onAbort = () => controller.abort();
    external?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: streaming ? 'text/event-stream' : 'application/json',
          ...this.defaultHeaders,
          ...options?.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new AIGatewayTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  private async toError(response: Response): Promise<AIGatewayError> {
    const requestId = response.headers.get('x-request-id') ?? undefined;
    let body: ErrorBody;
    try {
      body = (await response.json()) as ErrorBody;
      if (!body?.error?.type) throw new Error('not a gateway error body');
    } catch {
      body = {
        error: {
          type: response.status >= 500 ? 'internal_error' : 'invalid_request',
          message: `The gateway returned HTTP ${response.status}.`,
          retryable: response.status >= 500,
        },
      };
    }
    return new AIGatewayError(response.status, body, requestId);
  }
}

export interface RouteTestResult {
  simulated: true;
  note: string;
  strategy: string;
  requiredCapabilities: string[];
  estimatedInputTokens: number;
  estimateIsApproximate: boolean;
  selected: { provider: string; model: string; score: number; reasons: string[] } | null;
  chain: Array<{
    position: number;
    role: 'primary' | 'fallback';
    provider: string;
    model: string;
    score: number;
    reasons: string[];
    signals: Record<string, unknown>;
  }>;
  rejected: Array<{ target: string; reason: string }>;
  planReasons: string[];
}

export interface UsageResponse {
  range: { from: string; to: string; bucketMs: number };
  summary: Record<string, number | string | string[] | null>;
  series: Array<Record<string, number | string>>;
  breakdown: Record<string, Array<Record<string, number | string>>>;
  disclosure: { pricingVersion: string; pricingAgeDays: number; estimatedUsageShare: number; note: string };
}

export interface RequestTrace {
  request: Record<string, unknown>;
  steps: Array<{ name: string; status: string; startedAt: number; durationMs: number; detail?: Record<string, unknown> }>;
  attempts: Array<{
    attemptNumber: number; providerId: string; modelId: string; status: string;
    durationMs: number; errorType?: string; backoffMs?: number;
  }>;
  body: unknown;
  privacy: { mode?: string; retentionDays?: number; bodyStored: boolean; note: string };
}

function shouldRetry(error: AIGatewayError): boolean {
  // A 429 carries a retry-after the gateway computed; respecting it is the
  // caller's job, not something to paper over with an immediate retry.
  if (error.status === 429) return false;
  return error.retryable && error.status >= 500;
}

function backoff(attempt: number, lastError: unknown): number {
  if (lastError instanceof AIGatewayError && lastError.retryAfterSeconds) {
    return lastError.retryAfterSeconds * 1000;
  }
  const base = Math.min(8_000, 250 * 2 ** (attempt - 1));
  return Math.round(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}
