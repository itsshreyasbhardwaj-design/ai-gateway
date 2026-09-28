import type { ModelDescriptor, ProviderCallContext } from '@ai-gateway/core';

/** Helpers shared by adapter tests and the failure-injection suite. */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  /** SSE event payloads, emitted in order, each already JSON-serializable. */
  sse?: unknown[];
  /** Raw SSE text, for testing chunk-boundary handling. */
  sseRaw?: string;
  headers?: Record<string, string>;
  /** Throw a network-level error instead of responding. */
  networkError?: string;
  /** Never resolve, so the client's own deadline fires. */
  hang?: boolean;
}

export interface StubFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

export function stubFetch(responses: StubResponse | StubResponse[]): StubFetch {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: RecordedCall[] = [];
  const last = queue[queue.length - 1];

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const spec = (queue.length > 1 ? queue.shift() : queue[0]) ?? last ?? {};
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: normalizeHeaders(init?.headers),
      body: init?.body ? safeParse(String(init.body)) : undefined,
    });

    if (spec.networkError) {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = { code: spec.networkError };
      throw err;
    }

    if (spec.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }

    const status = spec.status ?? 200;
    const headers = new Headers({ 'content-type': 'application/json', ...spec.headers });

    if (spec.sse || spec.sseRaw !== undefined) {
      headers.set('content-type', 'text/event-stream');
      const text = spec.sseRaw ?? `${(spec.sse ?? []).map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
      return new Response(streamOf(text), { status, headers });
    }

    return new Response(spec.json === undefined ? '' : JSON.stringify(spec.json), { status, headers });
  }) as typeof fetch;

  return { fetch: impl, calls };
}

/** Emits the body in small pieces so SSE framing across chunk boundaries is exercised. */
function streamOf(text: string, pieceSize = 17): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= text.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(text.slice(offset, offset + pieceSize)));
      offset += pieceSize;
    },
  });
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function testModel(over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/model-a',
    providerId: 'test',
    providerModelId: 'model-a',
    displayName: 'Model A',
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    capabilities: ['chat', 'streaming', 'tools'],
    status: 'available',
    ...over,
  };
}

export function testCallContext(over: Partial<ProviderCallContext> = {}): ProviderCallContext {
  return {
    requestId: 'req_test',
    attempt: 1,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    model: testModel(),
    ...over,
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
