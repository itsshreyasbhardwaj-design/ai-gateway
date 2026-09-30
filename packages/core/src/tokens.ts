import type { ChatMessage, ContentPart, MeasuredUsage, TokenUsage } from './types/chat.js';

/**
 * Character-per-token divisor used by the estimator.
 *
 * This is a heuristic, not a tokenizer. Anything it produces is tagged
 * `source: 'estimated'` and the dashboard labels it as an estimate. The gateway
 * never presents an estimate as a provider-reported number, because billing
 * disputes get settled with the provider's numbers, not ours.
 */
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4;
/** Rough cost of a low-detail image tile; vision pricing varies widely by provider. */
const IMAGE_TOKEN_ESTIMATE = 800;

function estimateText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimatePart(part: ContentPart): number {
  if (part.type === 'text') return estimateText(part.text);
  return part.image_url.detail === 'low'
    ? Math.round(IMAGE_TOKEN_ESTIMATE / 4)
    : IMAGE_TOKEN_ESTIMATE;
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = PER_MESSAGE_OVERHEAD;
  if (typeof message.content === 'string') {
    total += estimateText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) total += estimatePart(part);
  }
  if (message.name) total += estimateText(message.name);
  for (const call of message.tool_calls ?? []) {
    total += estimateText(call.function.name) + estimateText(call.function.arguments);
  }
  return total;
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0) + 2;
}

export function estimateCompletionTokens(text: string): number {
  return estimateText(text);
}

export function estimatedUsage(input: number, output: number): MeasuredUsage {
  return { input, output, total: input + output, source: 'estimated' };
}

export function reportedUsage(usage: TokenUsage): MeasuredUsage {
  return {
    ...usage,
    total: usage.total || usage.input + usage.output,
    source: 'provider_reported',
  };
}

export function addUsage(
  a: MeasuredUsage | undefined,
  b: MeasuredUsage | undefined,
): MeasuredUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    cachedInput: (a.cachedInput ?? 0) + (b.cachedInput ?? 0) || undefined,
    // A sum is only as trustworthy as its least trustworthy term.
    source:
      a.source === 'provider_reported' && b.source === 'provider_reported'
        ? 'provider_reported'
        : 'estimated',
  };
}
