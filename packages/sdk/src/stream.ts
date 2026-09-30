import type { ChatCompletionChunk, RoutingReceipt } from './types.js';
import { AIGatewayError } from './errors.js';

const DONE = '[DONE]';

/**
 * A streaming chat completion.
 *
 * Iterating yields OpenAI-shaped chunks. The gateway's terminal routing receipt
 * arrives as its own frame at the end of the stream and is exposed through
 * `receipt` rather than being yielded as a chunk, so `for await` loops written
 * against the OpenAI SDK keep working unchanged.
 */
export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  private _receipt?: RoutingReceipt;
  private _text = '';
  private _chunks: ChatCompletionChunk[] = [];

  constructor(
    private readonly body: ReadableStream<Uint8Array>,
    readonly requestId: string | undefined,
    private readonly controller: AbortController,
  ) {}

  /** Routing receipt, available once the stream has been fully consumed. */
  get receipt(): RoutingReceipt | undefined {
    return this._receipt;
  }

  /** Assembled assistant text seen so far. */
  get text(): string {
    return this._text;
  }

  /** Stop the stream and let the gateway know the client has gone. */
  abort(): void {
    this.controller.abort();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatCompletionChunk> {
    const reader = this.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = this.handleBlock(block);
          if (frame) yield frame;
          boundary = buffer.indexOf('\n\n');
        }
      }
      const trailing = this.handleBlock(buffer);
      if (trailing) yield trailing;
    } finally {
      reader.releaseLock();
    }
  }

  private handleBlock(block: string): ChatCompletionChunk | null {
    const lines = block.split('\n').filter((line) => line.startsWith('data:'));
    if (lines.length === 0) return null;
    const data = lines.map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === DONE) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }

    // An in-band error frame: the HTTP status was already 200 when the stream
    // opened, so failures can only be reported this way.
    if (parsed['error']) {
      throw new AIGatewayError(502, parsed as never, this.requestId);
    }

    if (parsed['gateway'] && !parsed['choices']) {
      this._receipt = parsed['gateway'] as RoutingReceipt;
      return null;
    }

    const chunk = parsed as unknown as ChatCompletionChunk;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) this._text += delta;
    this._chunks.push(chunk);
    return chunk;
  }

  /** Drain the stream and return the assembled text plus the receipt. */
  async finalText(): Promise<{ text: string; receipt?: RoutingReceipt }> {
    for await (const _chunk of this) {
      /* accumulation happens in handleBlock */
    }
    return { text: this._text, receipt: this._receipt };
  }
}
