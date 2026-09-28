export * from './book.js';
export * from './cost.js';
export * from './seed.js';

import { PricingBook } from './book.js';
import { seedPricing } from './seed.js';

/** Convenience factory for a book preloaded with the placeholder snapshot. */
export function createSeedPricingBook(): PricingBook {
  return new PricingBook(seedPricing);
}
