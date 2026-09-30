import { describe, expect, it } from 'vitest';
import { inspectProviderUrl, isPrivateHost, assertSafeProviderUrl } from './ssrf.js';
import {
  constantTimeEquals,
  extractPrefix,
  generateApiKey,
  isWellFormedApiKey,
  keyIndex,
  scopesSatisfy,
  verifyApiKey,
} from './api-keys.js';
import { SecretBox, deriveKey, EncryptionKeyError } from './encryption.js';
import { generateWebhookSecret, signWebhook, verifyWebhook } from './webhooks.js';

describe('SSRF guard', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://127.0.0.1:8080/v1',
    'https://10.0.0.5/v1',
    'https://172.16.4.2/v1',
    'https://192.168.1.1/v1',
    'https://localhost/v1',
    'https://[::1]/v1',
    'https://2130706433/v1', // decimal-encoded 127.0.0.1
    'https://0x7f000001/v1', // hex-encoded 127.0.0.1
    'https://[::ffff:127.0.0.1]/v1',
    'https://100.64.0.1/v1', // carrier-grade NAT
    'https://user:pass@api.example.com/v1',
    'file:///etc/passwd',
    'gopher://example.com/',
  ];

  for (const url of blocked) {
    it(`rejects ${url}`, () => {
      expect(inspectProviderUrl(url).ok).toBe(false);
    });
  }

  it('allows an ordinary public https endpoint', () => {
    expect(inspectProviderUrl('https://api.vendor.example/v1').ok).toBe(true);
  });

  it('rejects plain http on a public host by default', () => {
    expect(inspectProviderUrl('http://api.vendor.example/v1').ok).toBe(false);
  });

  it('honours an explicit operator allowlist for self-hosted models', () => {
    const opts = { allowedHosts: ['ollama.internal', '127.0.0.1'] };
    expect(inspectProviderUrl('http://ollama.internal:11434/v1', opts).ok).toBe(true);
    expect(inspectProviderUrl('http://127.0.0.1:8000/v1', opts).ok).toBe(true);
    // Allowlisting one host must not open up its neighbours.
    expect(inspectProviderUrl('http://other.internal:11434/v1', opts).ok).toBe(false);
  });

  it('supports wildcard allowlist entries', () => {
    const opts = { allowedHosts: ['*.svc.cluster.local'] };
    expect(inspectProviderUrl('http://vllm.svc.cluster.local/v1', opts).ok).toBe(true);
    expect(inspectProviderUrl('http://vllm.svc.cluster.evil/v1', opts).ok).toBe(false);
  });

  it('throws a normalized gateway error from the assert form', () => {
    expect(() => assertSafeProviderUrl('http://169.254.169.254/')).toThrow(
      /Rejected provider base URL/,
    );
  });

  it('classifies loopback and link-local hosts as private', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });
});

describe('API keys', () => {
  it('returns a plaintext exactly once and stores only a hash', async () => {
    const key = await generateApiKey('live');
    expect(key.plaintext.startsWith('aigw_live_')).toBe(true);
    expect(key.hash.startsWith('scrypt$')).toBe(true);
    expect(key.hash).not.toContain(key.plaintext);
  });

  it('verifies the correct key and rejects a wrong one', async () => {
    const key = await generateApiKey();
    expect(await verifyApiKey(key.plaintext, key.hash)).toBe(true);
    expect(await verifyApiKey(`${key.plaintext}x`, key.hash)).toBe(false);
  });

  it('returns false instead of throwing on a malformed stored hash', async () => {
    expect(await verifyApiKey('aigw_live_abc', 'not-a-hash')).toBe(false);
    expect(await verifyApiKey('aigw_live_abc', 'scrypt$x$y$z$q$r')).toBe(false);
  });

  it('derives a stable searchable prefix', async () => {
    const key = await generateApiKey('test');
    expect(extractPrefix(key.plaintext)).toBe(key.prefix);
    expect(extractPrefix('garbage')).toBeNull();
    expect(isWellFormedApiKey(key.plaintext)).toBe(true);
    expect(isWellFormedApiKey('Bearer nope')).toBe(false);
  });

  it('produces a deterministic peppered lookup index', async () => {
    const key = await generateApiKey();
    expect(keyIndex(key.plaintext, 'pepper')).toBe(keyIndex(key.plaintext, 'pepper'));
    expect(keyIndex(key.plaintext, 'pepper')).not.toBe(keyIndex(key.plaintext, 'other-pepper'));
  });

  it('compares strings without leaking length through an exception', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });

  it('treats admin as a superset of every scope', () => {
    expect(scopesSatisfy(['admin'], 'logs.read')).toBe(true);
    expect(scopesSatisfy(['models.read'], 'inference.create')).toBe(false);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox('a'.repeat(32));

  it('round-trips a secret', () => {
    const blob = box.encrypt('sk-provider-secret');
    expect(blob).not.toContain('sk-provider-secret');
    expect(box.decrypt(blob)).toBe('sk-provider-secret');
  });

  it('produces a different ciphertext each time', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a tampered ciphertext', () => {
    const blob = box.encrypt('secret');
    const parts = blob.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  it('binds additional authenticated data', () => {
    const blob = box.encrypt('secret', 'provider:openai');
    expect(box.decrypt(blob, 'provider:openai')).toBe('secret');
    expect(() => box.decrypt(blob, 'provider:anthropic')).toThrow();
  });

  it('refuses a weak key', () => {
    expect(() => deriveKey('short')).toThrow(EncryptionKeyError);
  });

  it('passes its own self-test', () => {
    expect(box.selfTest()).toBe(true);
  });
});

describe('webhook signatures', () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ type: 'budget.exceeded', amount: 100 });

  it('verifies a freshly signed payload', () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(verifyWebhook(body, header, secret, now).valid).toBe(true);
  });

  it('rejects a modified body', () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    const result = verifyWebhook(`${body} `, header, secret, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects a replayed payload outside the tolerance window', () => {
    const signedAt = 1_700_000_000;
    const header = signWebhook(body, secret, signedAt);
    const result = verifyWebhook(body, header, secret, signedAt + 3600);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_tolerance');
  });

  it('rejects a wrong secret', () => {
    const now = 1_700_000_000;
    const header = signWebhook(body, secret, now);
    expect(verifyWebhook(body, header, generateWebhookSecret(), now).valid).toBe(false);
  });

  it('reports malformed headers', () => {
    expect(verifyWebhook(body, 'garbage', secret).reason).toBe('malformed');
  });
});
