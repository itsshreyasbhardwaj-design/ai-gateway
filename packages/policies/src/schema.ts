import { z } from 'zod';

export const routingStrategySchema = z.enum([
  'explicit',
  'lowest_cost',
  'lowest_latency',
  'highest_reliability',
  'weighted',
  'priority',
  'round_robin',
  'fallback_chain',
]);

const modelRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9._:-]+$/, 'must be "<provider>/<model>"');

const modelEntrySchema = z.union([
  modelRefSchema,
  z.object({
    model: modelRefSchema,
    weight: z.number().positive().max(1000).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
  }),
]);

export const retrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    initialDelayMs: z.number().int().min(0).max(60_000).default(250),
    maxDelayMs: z.number().int().min(0).max(300_000).default(8_000),
    backoff: z.enum(['exponential', 'linear', 'constant']).default('exponential'),
    factor: z.number().min(1).max(10).default(2),
    jitter: z.enum(['none', 'full', 'equal']).default('full'),
    respectRetryAfter: z.boolean().default(true),
  })
  .strict();

export const fallbackSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxTargets: z.number().int().min(1).max(10).default(3),
  })
  .strict();

export const cacheSchema = z
  .object({
    mode: z.enum(['off', 'exact', 'semantic']).default('off'),
    ttlSeconds: z.number().int().min(0).max(2_592_000).default(3_600),
    similarityThreshold: z.number().min(0).max(1).default(0.95),
    crossModel: z.boolean().default(false),
    perProject: z.boolean().default(true),
    excludeTags: z.array(z.string().max(64)).max(32).optional(),
  })
  .strict();

export const limitsSchema = z
  .object({
    /** Hard ceiling on `max_tokens`, applied even when the caller asks for more. */
    maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
    /** Reject requests whose estimated prompt exceeds this. */
    maxInputTokens: z.number().int().min(1).max(10_000_000).optional(),
    maxRequestBytes: z.number().int().min(1024).max(100_000_000).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
    /** Forbid streaming, e.g. for a batch-only project. */
    allowStreaming: z.boolean().default(true),
    allowTools: z.boolean().default(true),
  })
  .strict();

/**
 * Rate limits.
 *
 * Expressed in the policy rather than hardcoded, because the right limit is a
 * property of the workload: a batch pipeline and an interactive chat app want
 * very different numbers, and an operator should not have to patch the gateway
 * to change one. Omitting a field leaves that rule off entirely.
 */
export const rateLimitsSchema = z
  .object({
    requestsPerMinutePerKey: z.number().int().min(1).max(1_000_000).optional(),
    requestsPerHourPerOrganization: z.number().int().min(1).max(100_000_000).optional(),
    tokensPerMinutePerKey: z.number().int().min(1).max(1_000_000_000).optional(),
    tokensPerDayPerOrganization: z.number().int().min(1).max(100_000_000_000).optional(),
  })
  .strict();

export const routingPolicySchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(1024).optional(),
    routing: z
      .object({
        strategy: routingStrategySchema.default('highest_reliability'),
        models: z.array(modelEntrySchema).min(1).max(20),
      })
      .strict(),
    fallback: fallbackSchema.default({ enabled: true, maxTargets: 3 }),
    retry: retrySchema.default({}),
    cache: cacheSchema.default({}),
    limits: limitsSchema.default({}),
    rateLimits: rateLimitsSchema.default({}),
    models: z
      .object({
        allow: z.array(modelRefSchema).optional(),
        deny: z.array(modelRefSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RoutingPolicyDocument = z.infer<typeof routingPolicySchema>;
export type PolicyModelEntry = z.infer<typeof modelEntrySchema>;

export function normalizeModelEntry(entry: PolicyModelEntry): {
  model: string;
  weight?: number;
  priority?: number;
} {
  return typeof entry === 'string' ? { model: entry } : entry;
}
