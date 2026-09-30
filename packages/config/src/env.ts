import { z } from 'zod';

/**
 * Environment schema.
 *
 * Everything optional has a working default, because a gateway that cannot
 * start without cloud infrastructure is not self-hostable. The only genuinely
 * required variable in production is ENCRYPTION_KEY, and even that is
 * auto-generated (with a loud warning) in development.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const csv = () =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- gateway service ---
  GATEWAY_PORT: int(8787),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  GATEWAY_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: bool(false),
  /** Trust X-Forwarded-For. Only enable behind a proxy you control. */
  TRUST_PROXY: bool(false),
  CORS_ORIGINS: csv(),

  // --- storage ---
  /** Omit for the in-memory store (development only; data is not durable). */
  DATABASE_URL: z.string().optional(),
  /** Omit for in-process counters (single replica only). */
  REDIS_URL: z.string().optional(),

  // --- secrets ---
  ENCRYPTION_KEY: z.string().optional(),
  /** Pepper for the API key lookup index. Rotating it invalidates every key. */
  API_KEY_PEPPER: z.string().optional(),

  // --- dashboard auth ---
  CLERK_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),

  // --- provider credentials (read by reference, never inlined into config) ---
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  LOCAL_MODEL_BASE_URL: z.string().optional(),
  LOCAL_MODEL_API_KEY: z.string().optional(),

  // --- behaviour ---
  /** Register the synthetic mock provider. Defaults on outside production. */
  ENABLE_MOCK_PROVIDER: z.string().optional(),
  /** Hosts allowed as custom provider base URLs despite being private. */
  PROVIDER_ALLOWED_HOSTS: csv(),
  /** Model used to embed prompts for the semantic cache. */
  SEMANTIC_CACHE_EMBEDDING_MODEL: z.string().optional(),
  DEFAULT_REQUEST_TIMEOUT_MS: int(120_000),
  MAX_REQUEST_BYTES: int(10_485_760),
  /** Seed a demo organization, project and API key on first boot. */
  SEED_DEMO_DATA: bool(false),
  /** Deterministic key for the demo seed, so docs and tests can quote it. */
  DEMO_API_KEY: z.string().optional(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface EnvIssue {
  variable: string;
  message: string;
}

export type EnvParseResult =
  | { ok: true; env: RawEnv; warnings: EnvIssue[] }
  | { ok: false; issues: EnvIssue[]; warnings: EnvIssue[] };

export function parseEnv(source: NodeJS.ProcessEnv = process.env): EnvParseResult {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({ variable: i.path.join('.'), message: i.message })),
      warnings: [],
    };
  }

  const env = result.data;
  const issues: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];
  const isProduction = env.NODE_ENV === 'production';

  if (!env.ENCRYPTION_KEY) {
    const message = 'Required to encrypt provider credentials at rest. Generate one with: openssl rand -base64 32';
    if (isProduction) issues.push({ variable: 'ENCRYPTION_KEY', message });
    else warnings.push({ variable: 'ENCRYPTION_KEY', message: `${message} A throwaway key will be generated for this process; stored secrets will not survive a restart.` });
  } else if (env.ENCRYPTION_KEY.length < 16) {
    issues.push({ variable: 'ENCRYPTION_KEY', message: 'Must be at least 16 characters.' });
  }

  if (!env.API_KEY_PEPPER) {
    const message = 'Required so API key lookups cannot be precomputed from a database dump.';
    if (isProduction) issues.push({ variable: 'API_KEY_PEPPER', message });
    else warnings.push({ variable: 'API_KEY_PEPPER', message: `${message} A throwaway pepper will be generated; existing keys will stop resolving after a restart.` });
  }

  if (isProduction && !env.DATABASE_URL) {
    issues.push({
      variable: 'DATABASE_URL',
      message: 'The in-memory store loses every request, key and policy on restart and cannot be used in production.',
    });
  }

  if (isProduction && !env.REDIS_URL) {
    warnings.push({
      variable: 'REDIS_URL',
      message: 'Without Redis, rate limits and spend counters are per-process. Correct for one replica only.',
    });
  }

  if (!isProduction && !env.DATABASE_URL) {
    warnings.push({ variable: 'DATABASE_URL', message: 'Using the in-memory store. Data is lost on restart.' });
  }

  if (env.TRUST_PROXY && !isProduction) {
    warnings.push({ variable: 'TRUST_PROXY', message: 'Client IPs will be read from X-Forwarded-For, which is spoofable unless a trusted proxy sets it.' });
  }

  return issues.length > 0 ? { ok: false, issues, warnings } : { ok: true, env, warnings };
}

/** Which provider credentials are actually present. */
export function availableProviderCredentials(env: RawEnv): string[] {
  const refs: Array<[string, string | undefined]> = [
    ['OPENAI_API_KEY', env.OPENAI_API_KEY],
    ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY],
    ['GOOGLE_AI_API_KEY', env.GOOGLE_AI_API_KEY],
    ['OPENROUTER_API_KEY', env.OPENROUTER_API_KEY],
    ['LOCAL_MODEL_API_KEY', env.LOCAL_MODEL_API_KEY],
  ];
  return refs.filter(([, value]) => !!value?.trim()).map(([ref]) => ref);
}

export function mockProviderEnabled(env: RawEnv): boolean {
  if (env.ENABLE_MOCK_PROVIDER !== undefined) {
    return ['1', 'true', 'yes', 'on'].includes(env.ENABLE_MOCK_PROVIDER.toLowerCase());
  }
  // On by default outside production so a fresh clone has something to route to.
  return env.NODE_ENV !== 'production';
}
