/**
 * Redaction used on every log line and every stored error body.
 *
 * The rule the gateway enforces: a secret that reaches a log is a secret that
 * has leaked. Header allow-listing is therefore positive, not negative - we
 * name the headers that may be logged rather than the ones that may not.
 */

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'anthropic-api-key',
  'openai-api-key',
  'x-auth-token',
  'x-gateway-key',
]);

/** Headers that are safe to persist verbatim on a request record. */
const LOGGABLE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'content-length',
  'user-agent',
  'x-request-id',
  'x-forwarded-for',
  'x-gateway-project',
]);

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|credential|authorization|private[_-]?key|access[_-]?key|session)/i;

/** Literal key shapes worth catching even when the surrounding key name is innocent. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\baigw_(live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export const REDACTED = '[redacted]';

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (SENSITIVE_HEADERS.has(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (!LOGGABLE_HEADERS.has(key)) continue;
    out[key] = redactString(String(value));
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || SENSITIVE_HEADERS.has(key.toLowerCase());
}

/** Deep-redact an arbitrary object before it reaches a log sink. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1)) as unknown as T;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out as unknown as T;
}

/** `aigw_live_abcd1234...` -> `aigw_live_abcd…` for display in UIs and logs. */
export function maskSecret(secret: string, visiblePrefix = 14): string {
  if (secret.length <= visiblePrefix) return REDACTED;
  return `${secret.slice(0, visiblePrefix)}${'*'.repeat(8)}`;
}
