import {
  GatewayError,
  type AIProvider,
  type ModelDescriptor,
  type ProviderConfig,
} from '@ai-gateway/core';
import { requireCredential, type CredentialResolver } from '@ai-gateway/provider-sdk';
import { assertSafeProviderUrl, type UrlGuardOptions } from '@ai-gateway/security';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { MockProvider, MOCK_MODELS } from './mock.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { SEED_CATALOG } from './catalog.js';

export type ProviderKind =
  'openai' | 'openai-compatible' | 'anthropic' | 'google' | 'openrouter' | 'local' | 'mock';

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
};

export interface BuildProviderOptions {
  config: ProviderConfig;
  credentials: CredentialResolver;
  /** SSRF policy applied to any operator-supplied base URL. */
  urlGuard?: UrlGuardOptions;
  fetchImpl?: typeof fetch;
}

export interface BuiltProvider {
  provider: AIProvider;
  models: ModelDescriptor[];
}

/**
 * Turn a stored provider configuration row into a live adapter.
 *
 * Two invariants enforced here rather than in the request path:
 *  - credentials are resolved by reference, so a config row never holds a secret
 *  - any base URL that did not come from the built-in defaults is SSRF-checked
 */
export async function buildProvider(opts: BuildProviderOptions): Promise<BuiltProvider> {
  const { config, credentials } = opts;
  const kind = config.kind as ProviderKind;

  if (kind === 'mock') {
    const provider = new MockProvider({ id: config.id });
    return { provider, models: config.models ?? rekey(MOCK_MODELS, config.id) };
  }

  const baseUrl = resolveBaseUrl(config, opts.urlGuard);
  const models = config.models?.length ? config.models : defaultModelsFor(config.id, kind);

  if (models.length === 0) {
    throw new GatewayError(
      'invalid_request',
      `Provider "${config.id}" has no models configured and no seed catalog entry.`,
      { provider: config.id },
    );
  }

  const apiKey = config.credential
    ? await requireCredential(credentials, config.credential.ref, config.id)
    : undefined;

  switch (kind) {
    case 'anthropic': {
      if (!apiKey) throw missingCredential(config.id);
      return {
        provider: new AnthropicProvider({
          id: config.id,
          baseUrl,
          apiKey,
          models,
          timeoutMs: config.timeoutMs,
          fetchImpl: opts.fetchImpl,
        }),
        models,
      };
    }
    case 'google': {
      if (!apiKey) throw missingCredential(config.id);
      return {
        provider: new GoogleProvider({
          id: config.id,
          baseUrl,
          apiKey,
          models,
          timeoutMs: config.timeoutMs,
          fetchImpl: opts.fetchImpl,
        }),
        models,
      };
    }
    case 'openai':
    case 'openrouter':
    case 'local':
    case 'openai-compatible': {
      // Self-hosted runtimes routinely need no key at all.
      if (!apiKey && kind !== 'local' && kind !== 'openai-compatible') {
        throw missingCredential(config.id);
      }
      return {
        provider: new OpenAICompatibleProvider({
          id: config.id,
          kind,
          displayName: config.displayName,
          baseUrl,
          apiKey,
          headers: config.headers,
          models,
          timeoutMs: config.timeoutMs,
          fetchImpl: opts.fetchImpl,
        }),
        models,
      };
    }
    default:
      throw new GatewayError('invalid_request', `Unknown provider kind "${config.kind}".`, {
        provider: config.id,
      });
  }
}

function resolveBaseUrl(config: ProviderConfig, guard?: UrlGuardOptions): string {
  const fallback = DEFAULT_BASE_URLS[config.kind];
  if (!config.baseUrl) {
    if (!fallback) {
      throw new GatewayError(
        'invalid_request',
        `Provider "${config.id}" of kind "${config.kind}" requires an explicit baseUrl.`,
        { provider: config.id },
      );
    }
    return fallback;
  }
  // Anything an administrator typed gets checked, including overrides of a
  // known vendor's default endpoint.
  return assertSafeProviderUrl(config.baseUrl, guard).toString().replace(/\/+$/, '');
}

function defaultModelsFor(providerId: string, kind: ProviderKind): ModelDescriptor[] {
  const seed = SEED_CATALOG[providerId] ?? SEED_CATALOG[kind];
  return seed ? rekey(seed, providerId) : [];
}

function rekey(models: ModelDescriptor[], providerId: string): ModelDescriptor[] {
  return models.map((m) => ({ ...m, providerId, id: `${providerId}/${m.providerModelId}` }));
}

function missingCredential(providerId: string): GatewayError {
  return new GatewayError(
    'authentication_error',
    `Provider "${providerId}" requires a credential reference but none is configured.`,
    { provider: providerId },
  );
}
