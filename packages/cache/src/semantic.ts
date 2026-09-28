import type { ChatRequest } from '@ai-gateway/core';
import type { KeyValueStore } from './kv.js';
import type { CachedCompletion } from './exact.js';
import { parameterFingerprint, scopeKey, semanticText, sha256, type CacheScope } from './key.js';

/** Produces an embedding for cache lookup. Supplied by the gateway from a configured model. */
export type EmbedFn = (text: string, signal?: AbortSignal) => Promise<number[]>;

export interface SemanticEntry {
  id: string;
  vector: number[];
  /** Parameter fingerprint of the original request. Must match to serve a hit. */
  params: string;
  entry: CachedCompletion;
  storedAt: number;
  /** Truncated prompt text, kept only for debugging in the dashboard. */
  preview?: string;
}

export interface SemanticHit {
  entry: CachedCompletion;
  similarity: number;
  id: string;
}

export interface SemanticCacheConfig {
  /** Cosine similarity floor. Below this, it is a miss. */
  similarityThreshold: number;
  ttlSeconds: number;
  /** Entries retained per scope. Bounds both memory and lookup cost. */
  maxEntriesPerScope: number;
  /** Store a short prompt preview for debugging. Off by default for privacy. */
  storePreview: boolean;
}

export const DEFAULT_SEMANTIC_CONFIG: SemanticCacheConfig = {
  similarityThreshold: 0.95,
  ttlSeconds: 3_600,
  maxEntriesPerScope: 500,
  storePreview: false,
};

/**
 * Semantic (near-match) cache.
 *
 * Scope isolation is structural: vectors live under a key derived from the
 * organization id, so a similarity search cannot reach another tenant's
 * entries even if the embedding is identical.
 *
 * The index is a bounded brute-force cosine scan - at `maxEntriesPerScope`
 * defaults that is a few hundred dot products, which is cheap next to a model
 * call. It is honestly not a vector database: deployments that need more should
 * implement `VectorIndex` against pgvector or Redis Search. See
 * `docs/caching.md`.
 */
export class SemanticCache {
  private readonly config: SemanticCacheConfig;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly embed: EmbedFn,
    config: Partial<SemanticCacheConfig> = {},
  ) {
    this.config = { ...DEFAULT_SEMANTIC_CONFIG, ...config };
  }

  private indexKey(scope: CacheScope): string {
    return `cache:semantic:${scopeKey(scope)}`;
  }

  async lookup(
    scope: CacheScope,
    request: ChatRequest,
    thresholdOverride?: number,
    signal?: AbortSignal,
  ): Promise<SemanticHit | null> {
    const threshold = clamp01(thresholdOverride ?? this.config.similarityThreshold);
    const raw = await this.kv.listRange(this.indexKey(scope), 0, this.config.maxEntriesPerScope - 1);
    if (raw.length === 0) return null;

    const queryVector = await this.embed(semanticText(request), signal);
    const fingerprint = parameterFingerprint(request);
    const now = Date.now();

    let best: SemanticHit | null = null;
    for (const item of raw) {
      const candidate = parse(item);
      if (!candidate) continue;
      if (now - candidate.storedAt > this.config.ttlSeconds * 1000) continue;
      // A near-identical prompt asked with different parameters is a different
      // request. Similarity does not override an explicit temperature or tool set.
      if (candidate.params !== fingerprint) continue;

      const similarity = cosineSimilarity(queryVector, candidate.vector);
      if (similarity >= threshold && (!best || similarity > best.similarity)) {
        best = { entry: candidate.entry, similarity, id: candidate.id };
      }
    }
    return best;
  }

  async store(scope: CacheScope, request: ChatRequest, entry: CachedCompletion, signal?: AbortSignal): Promise<string> {
    const text = semanticText(request);
    const vector = await this.embed(text, signal);
    const id = sha256(`${scopeKey(scope)}:${text}`);
    const record: SemanticEntry = {
      id,
      vector,
      params: parameterFingerprint(request),
      entry,
      storedAt: Date.now(),
      ...(this.config.storePreview ? { preview: text.slice(0, 200) } : {}),
    };
    await this.kv.listPush(
      this.indexKey(scope),
      JSON.stringify(record),
      this.config.maxEntriesPerScope,
      this.config.ttlSeconds,
    );
    return id;
  }

  async invalidate(scope: CacheScope): Promise<void> {
    await this.kv.del(this.indexKey(scope));
  }

  async size(scope: CacheScope): Promise<number> {
    return (await this.kv.listRange(this.indexKey(scope), 0, -1)).length;
  }
}

function parse(raw: string): SemanticEntry | null {
  try {
    return JSON.parse(raw) as SemanticEntry;
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
