import type { MeasuredUsage, ModelPricing, UsageSource } from '@ai-gateway/core';

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  pricingVersion: string;
  /**
   * `provider_reported` means the token counts came from the provider and the
   * cost is a faithful application of the configured price table. `estimated`
   * means the token counts were approximated by the gateway.
   *
   * Either way the *cost* is an estimate: only the provider's invoice is
   * authoritative. The dashboard says so.
   */
  usageSource: UsageSource;
}

/** Prices are quoted per million tokens. */
const PER_MILLION = 1_000_000;

export function computeCost(
  usage: MeasuredUsage,
  pricing: ModelPricing,
  pricingVersion: string,
): CostBreakdown {
  const cachedInput = usage.cachedInput ?? 0;
  const freshInput = Math.max(0, usage.input - cachedInput);

  const cachedRate = pricing.cachedInputPerMillionTokens ?? pricing.inputPerMillionTokens;

  const inputCost =
    (freshInput * pricing.inputPerMillionTokens) / PER_MILLION +
    (cachedInput * cachedRate) / PER_MILLION;
  const outputCost = (usage.output * pricing.outputPerMillionTokens) / PER_MILLION;

  return {
    inputCost: round(inputCost),
    outputCost: round(outputCost),
    totalCost: round(inputCost + outputCost),
    currency: pricing.currency,
    pricingVersion,
    usageSource: usage.source,
  };
}

/**
 * Project a cost before the call is made, from the prompt estimate and the
 * caller's `max_tokens`. Used by budget pre-checks and the lowest-cost router,
 * both of which have to decide *before* any tokens exist.
 */
export function projectCost(
  estimatedInputTokens: number,
  maxOutputTokens: number,
  pricing: ModelPricing,
): number {
  return round(
    (estimatedInputTokens * pricing.inputPerMillionTokens) / PER_MILLION +
      (maxOutputTokens * pricing.outputPerMillionTokens) / PER_MILLION,
  );
}

/** Round to 8 decimals: enough for per-request costs measured in micro-currency. */
function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function formatCost(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : '';
  if (amount === 0) return `${symbol}0.00`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(6)}`;
  return `${symbol}${amount.toFixed(4)}`;
}
