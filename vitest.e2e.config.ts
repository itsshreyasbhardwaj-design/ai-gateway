import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './vitest.aliases';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The e2e suite boots one shared gateway per file; keep files serial.
    fileParallelism: false,
  },
});
