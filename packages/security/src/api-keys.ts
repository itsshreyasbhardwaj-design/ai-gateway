import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ApiKeyScope } from '@ai-gateway/core';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

export type KeyEnvironment = 'live' | 'test';

const PREFIX = 'aigw';
/** Bytes of entropy in the secret half of the key. */
const SECRET_BYTES = 24;
/** Characters of the secret kept in the searchable prefix. */
const PREFIX_CHARS = 6;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const HASH_BYTES = 32;

export interface GeneratedApiKey {
  /** The full secret. Shown to the operator exactly once and never persisted. */
  plaintext: string;
  /** Non-secret, searchable, safe to log and display: `aigw_live_a1b2c3`. */
  prefix: string;
  /** `scrypt$N$r$p$salt$hash`, all base64url. Safe to persist. */
  hash: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Mint an API key.
 *
 * The plaintext is returned once. Only a salted scrypt hash is stored, so a
 * database compromise does not yield usable gateway credentials.
 */
export async function generateApiKey(env: KeyEnvironment = 'live'): Promise<GeneratedApiKey> {
  const secret = b64url(randomBytes(SECRET_BYTES));
  const plaintext = `${PREFIX}_${env}_${secret}`;
  const prefix = `${PREFIX}_${env}_${secret.slice(0, PREFIX_CHARS)}`;
  return { plaintext, prefix, hash: await hashApiKey(plaintext) };
}

export async function hashApiKey(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plaintext, salt, HASH_BYTES, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${b64url(salt)}$${b64url(derived)}`;
}

/** Constant-time verification. Returns false for malformed stored hashes rather than throwing. */
export async function verifyApiKey(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(saltRaw ?? '', 'base64url');
    const expected = Buffer.from(hashRaw ?? '', 'base64url');
    if (expected.length !== HASH_BYTES) return false;
    const actual = await scrypt(plaintext, salt, HASH_BYTES, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Derive the searchable prefix from a presented key, for the O(1) lookup path. */
export function extractPrefix(plaintext: string): string | null {
  const match = /^aigw_(live|test)_([A-Za-z0-9_-]{6,})$/.exec(plaintext.trim());
  if (!match) return null;
  return `${PREFIX}_${match[1]}_${(match[2] ?? '').slice(0, PREFIX_CHARS)}`;
}

export function isWellFormedApiKey(plaintext: string): boolean {
  return extractPrefix(plaintext) !== null;
}

/**
 * Deterministic index for a key.
 *
 * Lets the gateway look a key up by a single hash comparison instead of scrypt-
 * verifying every candidate. The pepper must be secret; without it this is just
 * a prefix scan, with it an attacker holding the database still cannot
 * precompute lookups.
 */
export function keyIndex(plaintext: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plaintext).digest('base64url');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length doesn't leak through timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function scopesSatisfy(granted: ApiKeyScope[], required: ApiKeyScope): boolean {
  return granted.includes('admin') || granted.includes(required);
}
