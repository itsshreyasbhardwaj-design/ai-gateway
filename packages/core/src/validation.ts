import { z } from 'zod';
import { GatewayError } from './errors.js';

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']).transform((r) =>
    // `developer` is OpenAI's newer alias for a system turn.
    r === 'developer' ? ('system' as const) : r,
  ),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).default(null),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export const gatewayExtensionsSchema = z
  .object({
    strategy: z.string().optional(),
    models: z.array(z.string()).max(10).optional(),
    policy: z.string().optional(),
    cache: z.enum(['auto', 'no-store', 'exact-only', 'semantic']).optional(),
    cacheSimilarityThreshold: z.number().min(0).max(1).optional(),
    fallback: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
    test: z.boolean().optional(),
    tags: z.array(z.string().max(64)).max(16).optional(),
  })
  .strict();

export const chatRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(chatMessageSchema).min(1).max(2048),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
    max_completion_tokens: z.number().int().min(1).max(1_000_000).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
    n: z.number().int().min(1).max(8).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().optional(),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.string().min(1).max(128),
            description: z.string().max(4096).optional(),
            parameters: z.record(z.unknown()).optional(),
            strict: z.boolean().optional(),
          }),
        }),
      )
      .max(128)
      .optional(),
    tool_choice: z
      .union([
        z.enum(['none', 'auto', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
      ])
      .optional(),
    response_format: z
      .object({
        type: z.enum(['text', 'json_object', 'json_schema']),
        json_schema: z
          .object({
            name: z.string(),
            schema: z.record(z.unknown()),
            strict: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    user: z.string().max(256).optional(),
    metadata: z.record(z.string().max(512)).optional(),
    gateway: gatewayExtensionsSchema.optional(),
  })
  // Unknown top-level fields are dropped rather than rejected: OpenAI adds
  // parameters regularly and a gateway that 400s on them is a liability.
  .passthrough();

export const embeddingsRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z.union([z.string(), z.array(z.string()).min(1).max(2048)]),
    dimensions: z.number().int().min(1).max(8192).optional(),
    encoding_format: z.enum(['float', 'base64']).optional(),
    user: z.string().max(256).optional(),
    gateway: z
      .object({ test: z.boolean().optional(), tags: z.array(z.string()).max(16).optional() })
      .optional(),
  })
  .passthrough();

/** Parse with zod, converting failures into the gateway's normalized error shape. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what = 'request'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const path = first?.path.join('.') ?? '';
  const message = path
    ? `Invalid ${what}: ${path} ${first?.message ?? 'is invalid'}`
    : `Invalid ${what}: ${first?.message ?? 'failed validation'}`;
  throw new GatewayError('invalid_request', message, {
    details: { param: path || undefined },
  });
}
