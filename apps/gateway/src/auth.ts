import { GatewayError, type ApiKeyScope, type AuthContext } from '@ai-gateway/core';
import type { Store } from '@ai-gateway/database';
import { extractPrefix, keyIndex, verifyApiKey } from '@ai-gateway/security';

export interface AuthenticatedKey extends AuthContext {
  projectId: string;
  keyName: string;
  prefix: string;
}

export interface AuthDeps {
  store: Store;
  pepper: string;
  now?: () => Date;
}

/**
 * Authenticate a presented API key.
 *
 * The lookup is a single indexed read on a peppered HMAC, then one scrypt
 * verification. Notably it is *not* a scan that scrypt-checks every candidate,
 * which at a few thousand keys would make authentication the slowest part of
 * the request.
 *
 * Every failure returns the same message and the same 401. Distinguishing
 * "no such key" from "wrong key" tells an attacker which prefixes exist.
 */
export async function authenticate(deps: AuthDeps, header: string | undefined): Promise<AuthenticatedKey> {
  const presented = extractBearer(header);
  if (!presented) throw unauthorized();

  if (!extractPrefix(presented)) throw unauthorized();

  const record = await deps.store.findApiKeyByIndex(keyIndex(presented, deps.pepper));
  if (!record) throw unauthorized();

  if (!(await verifyApiKey(presented, record.hash))) throw unauthorized();

  const now = (deps.now ?? (() => new Date()))();

  if (record.revokedAt) {
    throw new GatewayError('authentication_error', 'This API key has been revoked.');
  }
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
    throw new GatewayError('authentication_error', 'This API key has expired.');
  }

  // Best-effort: a write failure here must not fail an otherwise valid request.
  void deps.store.touchApiKey(record.id, now.toISOString()).catch(() => undefined);

  return {
    organizationId: record.organizationId,
    projectId: record.projectId,
    apiKeyId: record.id,
    scopes: record.scopes,
    keyName: record.name,
    prefix: record.prefix,
  };
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match?.[1]) return match[1].trim();
  // Some SDKs send the raw key. Accept it rather than failing confusingly.
  return trimmed.startsWith('aigw_') ? trimmed : undefined;
}

function unauthorized(): GatewayError {
  return new GatewayError(
    'authentication_error',
    'Invalid API key. Pass it as "Authorization: Bearer aigw_live_...".',
  );
}

export function requireScopes(auth: AuthContext, ...scopes: ApiKeyScope[]): void {
  if (auth.scopes.includes('admin')) return;
  const missing = scopes.filter((scope) => !auth.scopes.includes(scope));
  if (missing.length > 0) {
    throw new GatewayError(
      'permission_denied',
      `This API key is missing the required scope${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      { details: { requiredScopes: scopes, grantedScopes: auth.scopes } },
    );
  }
}
