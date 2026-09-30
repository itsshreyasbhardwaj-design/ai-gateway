import type { ModelDescriptor } from '@ai-gateway/core';

/**
 * Seed model catalog.
 *
 * Like pricing, this is *configuration*, not knowledge the gateway claims to
 * hold. Context windows and capability flags here are a starting point that
 * operators are expected to review; providers exposing a discovery endpoint
 * (anything OpenAI-compatible) can refresh their own list at runtime via
 * `ProviderRegistry.setModels`.
 *
 * Nothing in the request path depends on these entries being exhaustive - an
 * unregistered model returns `model_not_found` rather than being guessed at.
 */

function model(
  providerId: string,
  providerModelId: string,
  displayName: string,
  contextWindow: number,
  capabilities: ModelDescriptor['capabilities'],
  extra: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    id: `${providerId}/${providerModelId}`,
    providerId,
    providerModelId,
    displayName,
    contextWindow,
    capabilities,
    status: 'available',
    ...extra,
  };
}

export const OPENAI_MODELS: ModelDescriptor[] = [
  model(
    'openai',
    'gpt-4o',
    'GPT-4o',
    128_000,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode'],
    { maxOutputTokens: 16_384, family: 'gpt' },
  ),
  model(
    'openai',
    'gpt-4o-mini',
    'GPT-4o mini',
    128_000,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode'],
    { maxOutputTokens: 16_384, family: 'gpt' },
  ),
  model(
    'openai',
    'gpt-4.1',
    'GPT-4.1',
    1_047_576,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode'],
    { maxOutputTokens: 32_768, family: 'gpt' },
  ),
  model(
    'openai',
    'gpt-4.1-mini',
    'GPT-4.1 mini',
    1_047_576,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode'],
    { maxOutputTokens: 32_768, family: 'gpt' },
  ),
  model(
    'openai',
    'o3-mini',
    'o3-mini',
    200_000,
    ['chat', 'streaming', 'tools', 'structured-output', 'reasoning'],
    { maxOutputTokens: 100_000, family: 'o-series' },
  ),
  model('openai', 'text-embedding-3-small', 'text-embedding-3-small', 8_191, ['embeddings'], {
    family: 'embedding',
  }),
  model('openai', 'text-embedding-3-large', 'text-embedding-3-large', 8_191, ['embeddings'], {
    family: 'embedding',
  }),
];

export const ANTHROPIC_MODELS: ModelDescriptor[] = [
  model(
    'anthropic',
    'claude-sonnet-4-20250514',
    'Claude Sonnet 4',
    200_000,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output'],
    { maxOutputTokens: 64_000, family: 'claude' },
  ),
  model(
    'anthropic',
    'claude-opus-4-20250514',
    'Claude Opus 4',
    200_000,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'reasoning'],
    { maxOutputTokens: 32_000, family: 'claude' },
  ),
  model(
    'anthropic',
    'claude-haiku-4-20250514',
    'Claude Haiku 4',
    200_000,
    ['chat', 'streaming', 'tools', 'vision'],
    { maxOutputTokens: 8_192, family: 'claude' },
  ),
];

export const GOOGLE_MODELS: ModelDescriptor[] = [
  model(
    'google',
    'gemini-2.0-flash',
    'Gemini 2.0 Flash',
    1_048_576,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode'],
    { maxOutputTokens: 8_192, family: 'gemini' },
  ),
  model(
    'google',
    'gemini-2.5-pro',
    'Gemini 2.5 Pro',
    1_048_576,
    ['chat', 'streaming', 'tools', 'vision', 'structured-output', 'json-mode', 'reasoning'],
    { maxOutputTokens: 65_536, family: 'gemini' },
  ),
  model('google', 'text-embedding-004', 'text-embedding-004', 2_048, ['embeddings'], {
    family: 'embedding',
  }),
];

/**
 * OpenRouter proxies many vendors behind one OpenAI-compatible endpoint.
 * The seed list is deliberately short: OpenRouter exposes `/models`, so the
 * real catalog is discovered at runtime.
 */
export const OPENROUTER_MODELS: ModelDescriptor[] = [
  model(
    'openrouter',
    'openai/gpt-4o-mini',
    'GPT-4o mini (via OpenRouter)',
    128_000,
    ['chat', 'streaming', 'tools', 'vision'],
    { family: 'gpt' },
  ),
  model(
    'openrouter',
    'anthropic/claude-sonnet-4',
    'Claude Sonnet 4 (via OpenRouter)',
    200_000,
    ['chat', 'streaming', 'tools', 'vision'],
    { family: 'claude' },
  ),
  model(
    'openrouter',
    'meta-llama/llama-3.1-70b-instruct',
    'Llama 3.1 70B Instruct (via OpenRouter)',
    131_072,
    ['chat', 'streaming', 'tools'],
    { family: 'llama' },
  ),
];

/** Local runtimes (Ollama, vLLM, LM Studio) speaking the OpenAI wire format. */
export const LOCAL_MODELS: ModelDescriptor[] = [
  model(
    'local',
    'llama-3.1-8b',
    'Llama 3.1 8B (self-hosted)',
    131_072,
    ['chat', 'streaming', 'tools'],
    { family: 'llama' },
  ),
  model('local', 'qwen2.5-7b', 'Qwen2.5 7B (self-hosted)', 32_768, ['chat', 'streaming', 'tools'], {
    family: 'qwen',
  }),
];

export const SEED_CATALOG: Record<string, ModelDescriptor[]> = {
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  google: GOOGLE_MODELS,
  openrouter: OPENROUTER_MODELS,
  local: LOCAL_MODELS,
};

/** Re-key a catalog entry onto a different provider id, for custom deployments. */
export function rekeyModels(models: ModelDescriptor[], providerId: string): ModelDescriptor[] {
  return models.map((m) => ({ ...m, providerId, id: `${providerId}/${m.providerModelId}` }));
}

/** Parse an OpenAI-compatible `/models` discovery payload. */
export function modelsFromDiscovery(
  providerId: string,
  payload: unknown,
  defaults: Partial<ModelDescriptor> = {},
): ModelDescriptor[] {
  const data = (payload as { data?: Array<Record<string, unknown>> } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => {
      const providerModelId = typeof entry['id'] === 'string' ? entry['id'] : undefined;
      if (!providerModelId) return null;
      const contextWindow =
        numberOf(entry['context_length']) ??
        numberOf(entry['context_window']) ??
        defaults.contextWindow ??
        8_192;
      return {
        id: `${providerId}/${providerModelId}`,
        providerId,
        providerModelId,
        displayName: typeof entry['name'] === 'string' ? entry['name'] : providerModelId,
        contextWindow,
        capabilities: defaults.capabilities ?? ['chat', 'streaming'],
        status: 'available' as const,
        ...defaults,
      } satisfies ModelDescriptor;
    })
    .filter((m): m is ModelDescriptor => m !== null);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
