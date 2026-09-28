export * from './types.js';
export * from './memory-store.js';
export * from './postgres-store.js';

import type { Store } from './types.js';
import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';

/**
 * Pick a store from the environment.
 *
 * No DATABASE_URL means the in-memory store, which is what makes a zero-infra
 * `pnpm dev` possible. The caller is expected to warn that data is not durable.
 */
export async function createStore(databaseUrl?: string): Promise<Store> {
  if (!databaseUrl) return new MemoryStore();
  const store = await PostgresStore.connect(databaseUrl);
  return store;
}
