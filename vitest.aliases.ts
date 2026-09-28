import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

const packages = [
  'core',
  'provider-sdk',
  'providers',
  'router',
  'policies',
  'cache',
  'rate-limit',
  'observability',
  'usage',
  'pricing',
  'security',
  'sdk',
  'database',
  'config',
];

/**
 * Map `@ai-gateway/<pkg>` straight at the TypeScript sources so unit tests run
 * without a build step. Production builds resolve through each package's
 * compiled `dist/` entrypoint instead.
 */
export const workspaceAliases: Record<string, string> = Object.fromEntries([
  ...packages.map((p) => [`@ai-gateway/${p}`, resolve(root, `packages/${p}/src/index.ts`)]),
  ['@ai-gateway/gateway', resolve(root, 'apps/gateway/src/index.ts')],
]);
