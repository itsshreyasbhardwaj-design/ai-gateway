import type { ModelPricing, PricingRecord } from '@ai-gateway/core';

export interface PricingSnapshot {
  version: string;
  /** Date the numbers were last checked against the providers' published pricing. */
  asOf: string;
  source: string;
  notes?: string;
  /** Keyed by `<providerId>/<providerModelId>`. */
  prices: Record<string, ModelPricing>;
}

export interface PricingLookup {
  modelId: string;
  pricing: ModelPricing;
  version: string;
}

/**
 * Versioned price table.
 *
 * Two rules the gateway depends on:
 *  1. Nothing in the codebase hardcodes a price. Everything reads this book.
 *  2. Cost rows record the version they were computed with, so updating prices
 *     never silently rewrites historical spend.
 */
export class PricingBook {
  private versions = new Map<string, PricingSnapshot>();
  private currentVersion: string;

  constructor(initial: PricingSnapshot) {
    this.versions.set(initial.version, initial);
    this.currentVersion = initial.version;
  }

  /** Register a newer snapshot. Existing versions stay queryable forever. */
  publish(snapshot: PricingSnapshot): void {
    if (this.versions.has(snapshot.version)) {
      throw new Error(`pricing version already published: ${snapshot.version}`);
    }
    this.versions.set(snapshot.version, snapshot);
    this.currentVersion = snapshot.version;
  }

  get version(): string {
    return this.currentVersion;
  }

  snapshot(version = this.currentVersion): PricingSnapshot | undefined {
    return this.versions.get(version);
  }

  listVersions(): PricingSnapshot[] {
    return [...this.versions.values()].sort((a, b) => a.version.localeCompare(b.version));
  }

  /** Look up a price, optionally pinned to a historical version. */
  lookup(modelId: string, version = this.currentVersion): PricingLookup | undefined {
    const snap = this.versions.get(version);
    const pricing = snap?.prices[modelId];
    if (!snap || !pricing) return undefined;
    return { modelId, pricing, version: snap.version };
  }

  has(modelId: string, version = this.currentVersion): boolean {
    return this.lookup(modelId, version) !== undefined;
  }

  toRecord(modelId: string, version = this.currentVersion): PricingRecord | undefined {
    const found = this.lookup(modelId, version);
    const snap = this.versions.get(version);
    if (!found || !snap) return undefined;
    return {
      ...found.pricing,
      pricingVersion: found.version,
      source: snap.source,
      effectiveFrom: snap.asOf,
      effectiveTo: found.version === this.currentVersion ? null : undefined,
    };
  }

  /**
   * How stale the active snapshot is, in days.
   *
   * The dashboard surfaces this next to every cost figure. The gateway never
   * claims its prices are current - it reports when they were last verified
   * and leaves the judgement to the operator.
   */
  ageInDays(now = Date.now()): number {
    const snap = this.versions.get(this.currentVersion);
    if (!snap) return Number.POSITIVE_INFINITY;
    const asOf = Date.parse(snap.asOf);
    if (Number.isNaN(asOf)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Math.floor((now - asOf) / 86_400_000));
  }

  /** Models priced in the active snapshot. */
  pricedModels(version = this.currentVersion): string[] {
    return Object.keys(this.versions.get(version)?.prices ?? {}).sort();
  }
}
