import { GatewayError } from '@ai-gateway/core';

/**
 * Resolves provider credentials by reference.
 *
 * Provider configuration rows hold the *name* of a secret, never its value, so
 * a database dump or an API response can never leak a provider key.
 */
export interface CredentialResolver {
  resolve(ref: string): Promise<string | undefined>;
  has(ref: string): Promise<boolean>;
}

/** Reads from `process.env`, which is how self-hosted deployments inject keys. */
export class EnvCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string | undefined> {
    const value = this.env[ref];
    return value && value.trim() ? value.trim() : undefined;
  }

  async has(ref: string): Promise<boolean> {
    return (await this.resolve(ref)) !== undefined;
  }
}

/** In-memory resolver for tests and for encrypted-at-rest secret stores. */
export class MapCredentialResolver implements CredentialResolver {
  constructor(private readonly entries = new Map<string, string>()) {}

  set(ref: string, value: string): void {
    this.entries.set(ref, value);
  }

  async resolve(ref: string): Promise<string | undefined> {
    return this.entries.get(ref);
  }

  async has(ref: string): Promise<boolean> {
    return this.entries.has(ref);
  }
}

/** Tries each resolver in order; the first hit wins. */
export class ChainCredentialResolver implements CredentialResolver {
  constructor(private readonly chain: CredentialResolver[]) {}

  async resolve(ref: string): Promise<string | undefined> {
    for (const resolver of this.chain) {
      const value = await resolver.resolve(ref);
      if (value) return value;
    }
    return undefined;
  }

  async has(ref: string): Promise<boolean> {
    return (await this.resolve(ref)) !== undefined;
  }
}

export async function requireCredential(
  resolver: CredentialResolver,
  ref: string,
  providerId: string,
): Promise<string> {
  const value = await resolver.resolve(ref);
  if (!value) {
    throw new GatewayError(
      'authentication_error',
      `Provider "${providerId}" is configured to use credential "${ref}", which is not set.`,
      { provider: providerId, details: { credentialRef: ref } },
    );
  }
  return value;
}
