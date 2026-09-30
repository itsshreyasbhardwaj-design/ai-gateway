import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.aliases';

/**
 * Integration tests against real backing services.
 *
 * They skip themselves without DATABASE_URL / REDIS_URL, so `pnpm test` stays
 * runnable with nothing installed. CI always provides both.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // These share real databases, so they must not run concurrently.
    fileParallelism: false,
  },
});
