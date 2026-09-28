import { describe, expect, it } from 'vitest';
import type { MeasuredUsage, ModelPricing } from '@ai-gateway/core';
import { computeCost, projectCost } from './cost.js';
import { PricingBook } from './book.js';
import { seedPricing } from './seed.js';

const pricing: ModelPricing = {
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
  cachedInputPerMillionTokens: 0.3,
  currency: 'USD',
};

const reported = (over: Partial<MeasuredUsage> = {}): MeasuredUsage => ({
  input: 1_000_000,
  output: 1_000_000,
  total: 2_000_000,
  source: 'provider_reported',
  ...over,
});

describe('computeCost', () => {
  it('applies per-million rates', () => {
    const cost = computeCost(reported(), pricing, 'v1');
    expect(cost.inputCost).toBe(3);
    expect(cost.outputCost).toBe(15);
    expect(cost.totalCost).toBe(18);
    expect(cost.currency).toBe('USD');
  });

  it('bills provider-cached input at the cached rate', () => {
    const cost = computeCost(reported({ cachedInput: 900_000 }), pricing, 'v1');
    // 100k fresh at $3/M + 900k cached at $0.30/M
    expect(cost.inputCost).toBeCloseTo(0.3 + 0.27, 8);
  });

  it('falls back to the standard input rate when no cached rate is configured', () => {
    const noCacheRate: ModelPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' };
    const cost = computeCost(reported({ cachedInput: 1_000_000 }), noCacheRate, 'v1');
    expect(cost.inputCost).toBe(3);
  });

  it('carries the usage source through so estimates stay labelled', () => {
    const cost = computeCost(reported({ source: 'estimated' }), pricing, 'v1');
    expect(cost.usageSource).toBe('estimated');
  });

  it('records the pricing version used', () => {
    expect(computeCost(reported(), pricing, 'v7').pricingVersion).toBe('v7');
  });

  it('handles zero-priced self-hosted models', () => {
    const free: ModelPricing = { inputPerMillionTokens: 0, outputPerMillionTokens: 0, currency: 'USD' };
    expect(computeCost(reported(), free, 'v1').totalCost).toBe(0);
  });
});

describe('projectCost', () => {
  it('prices the worst case from prompt estimate plus max output', () => {
    expect(projectCost(1_000_000, 1_000_000, pricing)).toBe(18);
  });
});

describe('PricingBook', () => {
  it('keeps historical versions queryable after a new one is published', () => {
    const book = new PricingBook(seedPricing);
    const before = book.lookup('openai/gpt-4o');
    expect(before?.pricing.inputPerMillionTokens).toBe(2.5);

    book.publish({
      version: 'v2',
      asOf: '2026-06-01',
      source: 'admin:test',
      prices: { 'openai/gpt-4o': { inputPerMillionTokens: 99, outputPerMillionTokens: 199, currency: 'USD' } },
    });

    expect(book.version).toBe('v2');
    expect(book.lookup('openai/gpt-4o')?.pricing.inputPerMillionTokens).toBe(99);
    // The whole point: yesterday's cost rows still reprice correctly.
    expect(book.lookup('openai/gpt-4o', seedPricing.version)?.pricing.inputPerMillionTokens).toBe(2.5);
  });

  it('refuses to overwrite an existing version', () => {
    const book = new PricingBook(seedPricing);
    expect(() => book.publish(seedPricing)).toThrow(/already published/);
  });

  it('reports staleness in days', () => {
    const book = new PricingBook({ ...seedPricing, asOf: '2026-01-01' });
    const tenDaysLater = Date.parse('2026-01-11T00:00:00Z');
    expect(book.ageInDays(tenDaysLater)).toBe(10);
  });

  it('returns undefined for unpriced models rather than guessing', () => {
    const book = new PricingBook(seedPricing);
    expect(book.lookup('openai/not-a-real-model')).toBeUndefined();
  });
});
