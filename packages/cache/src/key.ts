import { createHash } from 'node:crypto';
import type { ChatRequest, EmbeddingsRequest } from '@ai-gateway/core';

/**
 * Cache key derivation.
 *
 * Two rules that are load-bearing for correctness and for tenant isolation:
 *
 *  1. The organization id is part of every key. Two orgs sending byte-identical
 *     prompts must never see each other's completions.
 *  2. Every parameter that can change the output is in the key. Omitting one
 *     (temperature, tools, response_format, seed...) would serve a response the
 *     caller did not ask for, which is worse than a cache miss.
 */

export interface CacheScope {
  organizationId: string;
  /** Present when the policy scopes caching per project rather than per org. */
  projectId?: string;
  /** Model id, or a model family when the policy allows cross-model reuse. */
  modelScope: string;
}

export function scopeKey(scope: CacheScope): string {
  return [scope.organizationId, scope.projectId ?? '*', scope.modelScope].join(':');
}

/** Fields that alter the completion. Anything not listed here is excluded deliberately. */
function significantFields(request: ChatRequest): Record<string, unknown> {
  return {
    messages: request.messages,
    temperature: request.temperature ?? null,
    top_p: request.top_p ?? null,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? null,
    stop: request.stop ?? null,
    n: request.n ?? null,
    presence_penalty: request.presence_penalty ?? null,
    frequency_penalty: request.frequency_penalty ?? null,
    seed: request.seed ?? null,
    tools: request.tools ?? null,
    tool_choice: request.tool_choice ?? null,
    response_format: request.response_format ?? null,
  };
}

export function exactCacheKey(scope: CacheScope, request: ChatRequest): string {
  const payload = stableStringify({ scope: scopeKey(scope), ...significantFields(request) });
  return `cache:exact:${scopeKey(scope)}:${sha256(payload)}`;
}

export function embeddingsCacheKey(scope: CacheScope, request: EmbeddingsRequest): string {
  const payload = stableStringify({
    scope: scopeKey(scope),
    input: request.input,
    dimensions: request.dimensions ?? null,
  });
  return `cache:embed:${scopeKey(scope)}:${sha256(payload)}`;
}

/**
 * Text used for semantic similarity.
 *
 * Only the conversation text participates; sampling parameters do not, because
 * two prompts that differ only in temperature are still semantically the same
 * question. Those parameters are re-checked on hit before the entry is served.
 */
export function semanticText(request: ChatRequest): string {
  return request.messages
    .map((m) => {
      const content =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')
            : '';
      return `${m.role}: ${normalizeWhitespace(content)}`;
    })
    .join('\n');
}

/** Guard so a semantic hit can never ignore a parameter the caller set. */
export function parameterFingerprint(request: ChatRequest): string {
  const { messages: _messages, ...rest } = significantFields(request);
  return sha256(stableStringify(rest));
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
