import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for secrets at rest (provider API keys, webhook secrets).
 *
 * AES-256-GCM with a random 96-bit nonce per record. The stored blob carries
 * its own nonce and auth tag, so rotating the key is a re-encrypt, not a
 * schema change.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

export class EncryptionKeyError extends Error {}

/** Accepts either 32 raw bytes as base64/hex, or a passphrase that gets hashed to 32 bytes. */
export function deriveKey(material: string): Buffer {
  if (!material || material.length < 16) {
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY must be at least 16 characters. Generate one with: openssl rand -base64 32',
    );
  }
  for (const encoding of ['base64', 'hex'] as const) {
    try {
      const buf = Buffer.from(material, encoding);
      if (buf.length === 32) return buf;
    } catch {
      /* fall through to the hash path */
    }
  }
  return createHash('sha256').update(material).digest();
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string | Buffer) {
    this.key = Buffer.isBuffer(keyMaterial) ? keyMaterial : deriveKey(keyMaterial);
    if (this.key.length !== 32) throw new EncryptionKeyError('Encryption key must be 32 bytes.');
  }

  /** Returns `v1.<iv>.<ciphertext>.<tag>`, all base64url. */
  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
  }

  decrypt(blob: string, aad?: string): string {
    const parts = blob.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new EncryptionKeyError('Malformed encrypted value.');
    }
    const iv = Buffer.from(parts[1] ?? '', 'base64url');
    const ct = Buffer.from(parts[2] ?? '', 'base64url');
    const tag = Buffer.from(parts[3] ?? '', 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new EncryptionKeyError('Malformed encrypted value.');
    }
    const decipher = createDecipheriv(ALGO, this.key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** Round-trip check used by the gateway's startup self-test. */
  selfTest(): boolean {
    const probe = 'ai-gateway-selftest';
    return this.decrypt(this.encrypt(probe)) === probe;
  }
}
