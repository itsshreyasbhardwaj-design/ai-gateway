import { GatewayError, parseSseStream, SSE_DONE, type SseEvent } from '@ai-gateway/core';

/** Adapt a web ReadableStream into the async iterable the SSE parser expects. */
export async function* readableToIterable(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * Iterate an upstream SSE response, stopping at `[DONE]`.
 *
 * Nothing here buffers the whole response: each event is parsed and handed on
 * as it arrives, which is what keeps streaming time-to-first-token close to the
 * provider's own.
 */
export async function* iterateSseJson<T>(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  if (!response.body) {
    throw new GatewayError('provider_error', 'Provider stream had no body.');
  }
  for await (const event of parseSseStream(readableToIterable(response.body, signal))) {
    const data = event.data.trim();
    if (!data) continue;
    if (data === SSE_DONE) return;
    yield parseEvent<T>(data);
  }
}

/** Same as `iterateSseJson` but hands back the raw event for adapters that need `event:` names. */
export async function* iterateSseEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  if (!response.body) {
    throw new GatewayError('provider_error', 'Provider stream had no body.');
  }
  for await (const event of parseSseStream(readableToIterable(response.body, signal))) {
    if (event.data.trim() === SSE_DONE) return;
    yield event;
  }
}

function parseEvent<T>(data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch (err) {
    throw new GatewayError('provider_error', 'Provider emitted a malformed stream chunk.', {
      cause: err,
    });
  }
}
