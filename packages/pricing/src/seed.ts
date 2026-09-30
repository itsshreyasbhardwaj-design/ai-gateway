import type { PricingSnapshot } from './book.js';

/**
 * Illustrative seed pricing.
 *
 * These numbers are PLACEHOLDERS so a fresh install has a complete, working
 * cost pipeline out of the box. They are NOT verified against any provider's
 * current published pricing and must be replaced before any figure the gateway
 * reports is treated as a real cost.
 *
 * Replace them either by editing `pricing.json` (see `docs/pricing.md`) or via
 * `POST /api/v1/pricing/versions`, which publishes a new snapshot without
 * rewriting historical cost rows.
 *
 * `PricingBook.ageInDays()` and the `unverified` flag below drive the staleness
 * banner shown next to every cost figure in the dashboard.
 */
export const SEED_PRICING_VERSION = 'seed-unverified-v1';

export const seedPricing: PricingSnapshot = {
  version: SEED_PRICING_VERSION,
  asOf: '2026-01-01',
  source: 'seed:unverified-illustrative',
  notes:
    'PLACEHOLDER PRICING. Not verified against provider price lists. Publish a ' +
    'verified snapshot before relying on any cost figure.',
  prices: {
    // --- OpenAI-compatible tier examples -------------------------------
    'openai/gpt-4o': {
      inputPerMillionTokens: 2.5,
      outputPerMillionTokens: 10,
      cachedInputPerMillionTokens: 1.25,
      currency: 'USD',
    },
    'openai/gpt-4o-mini': {
      inputPerMillionTokens: 0.15,
      outputPerMillionTokens: 0.6,
      cachedInputPerMillionTokens: 0.075,
      currency: 'USD',
    },
    'openai/gpt-4.1': { inputPerMillionTokens: 2, outputPerMillionTokens: 8, currency: 'USD' },
    'openai/gpt-4.1-mini': {
      inputPerMillionTokens: 0.4,
      outputPerMillionTokens: 1.6,
      currency: 'USD',
    },
    'openai/o3-mini': { inputPerMillionTokens: 1.1, outputPerMillionTokens: 4.4, currency: 'USD' },
    'openai/text-embedding-3-small': {
      inputPerMillionTokens: 0.02,
      outputPerMillionTokens: 0,
      currency: 'USD',
    },
    'openai/text-embedding-3-large': {
      inputPerMillionTokens: 0.13,
      outputPerMillionTokens: 0,
      currency: 'USD',
    },

    // --- Anthropic-compatible tier examples ----------------------------
    'anthropic/claude-sonnet-4': {
      inputPerMillionTokens: 3,
      outputPerMillionTokens: 15,
      cachedInputPerMillionTokens: 0.3,
      currency: 'USD',
    },
    'anthropic/claude-opus-4': {
      inputPerMillionTokens: 15,
      outputPerMillionTokens: 75,
      cachedInputPerMillionTokens: 1.5,
      currency: 'USD',
    },
    'anthropic/claude-haiku-4': {
      inputPerMillionTokens: 0.8,
      outputPerMillionTokens: 4,
      cachedInputPerMillionTokens: 0.08,
      currency: 'USD',
    },

    // --- Google/Gemini tier examples -----------------------------------
    'google/gemini-2.0-flash': {
      inputPerMillionTokens: 0.1,
      outputPerMillionTokens: 0.4,
      currency: 'USD',
    },
    'google/gemini-2.5-pro': {
      inputPerMillionTokens: 1.25,
      outputPerMillionTokens: 10,
      currency: 'USD',
    },
    'google/text-embedding-004': {
      inputPerMillionTokens: 0.02,
      outputPerMillionTokens: 0,
      currency: 'USD',
    },

    // --- Local / self-hosted -------------------------------------------
    // Self-hosted inference has no per-token vendor price. Operators who want
    // amortized hardware cost attributed per token can publish a snapshot that
    // overrides these zeros.
    'local/llama-3.1-8b': { inputPerMillionTokens: 0, outputPerMillionTokens: 0, currency: 'USD' },
    'local/qwen2.5-7b': { inputPerMillionTokens: 0, outputPerMillionTokens: 0, currency: 'USD' },

    // --- Development mock provider --------------------------------------
    'mock/mock-fast': { inputPerMillionTokens: 0.05, outputPerMillionTokens: 0.2, currency: 'USD' },
    'mock/mock-smart': { inputPerMillionTokens: 3, outputPerMillionTokens: 12, currency: 'USD' },
    'mock/mock-flaky': { inputPerMillionTokens: 0.5, outputPerMillionTokens: 2, currency: 'USD' },
    'mock/mock-embed': { inputPerMillionTokens: 0.01, outputPerMillionTokens: 0, currency: 'USD' },
  },
};

/** True while the active snapshot is the shipped placeholder set. */
export function isUnverified(version: string): boolean {
  return version === SEED_PRICING_VERSION || version.startsWith('seed-unverified');
}
