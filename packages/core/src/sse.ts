/** Terminal marker in an OpenAI-compatible SSE stream. */
export const SSE_DONE = '[DONE]';

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export function formatSse(event: SseEvent): string {
  let out = '';
  if (event.id) out += `id: ${event.id}\n`;
  if (event.event) out += `event: ${event.event}\n`;
  for (const line of event.data.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

export function sseData(payload: unknown): string {
  return formatSse({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

/**
 * Parse an SSE byte stream into events.
 *
 * Buffers only up to one event boundary, so a long streaming response never
 * accumulates in gateway memory.
 */
export async function* parseSseStream(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = findBoundary(buffer);
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const event = parseEventBlock(raw);
      if (event) yield event;
      boundary = findBoundary(buffer);
    }
  }

  buffer += decoder.decode();
  const trailing = parseEventBlock(buffer);
  if (trailing) yield trailing;
}

function findBoundary(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseEventBlock(block: string): SseEvent | null {
  const trimmed = block.trim();
  if (!trimmed) return null;
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0) return null;
  const result: SseEvent = { data: dataLines.join('\n') };
  if (event) result.event = event;
  if (id) result.id = id;
  return result;
}
