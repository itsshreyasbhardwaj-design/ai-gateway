import { isIP } from 'node:net';
import { GatewayError } from '@ai-gateway/core';

/**
 * Guard for administrator-supplied provider base URLs.
 *
 * Custom providers are a genuinely useful feature and a genuinely dangerous
 * one: the gateway holds credentials and sits inside a private network, so an
 * attacker who can point it at `http://169.254.169.254/` gets cloud metadata.
 * The rule here is deny-by-default - a host must be publicly routable, or
 * explicitly allowlisted by the operator.
 */

export interface UrlGuardOptions {
  /**
   * Hosts the operator has deliberately permitted despite being private, e.g.
   * `["ollama.internal", "127.0.0.1", "*.svc.cluster.local"]`. Self-hosted
   * models normally need at least one entry here.
   */
  allowedHosts?: string[];
  /** Permit plain http. Off by default; on for localhost when allowlisted. */
  allowInsecureHttp?: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

export function inspectProviderUrl(raw: string, opts: UrlGuardOptions = {}): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Base URL is not a valid absolute URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `Unsupported URL scheme "${url.protocol}".` };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'Credentials embedded in the base URL are not allowed.' };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowed = matchesAllowlist(host, opts.allowedHosts ?? []);

  if (BLOCKED_HOSTNAMES.has(host) && !allowed) {
    return { ok: false, reason: `Host "${host}" is a cloud metadata endpoint.` };
  }

  if (url.protocol === 'http:' && !opts.allowInsecureHttp && !allowed) {
    return { ok: false, reason: 'Plain http is only allowed for explicitly allowlisted hosts.' };
  }

  if (isPrivateHost(host) && !allowed) {
    return {
      ok: false,
      reason: `Host "${host}" resolves to a private or reserved address. Add it to the provider allowlist if this is deliberate.`,
    };
  }

  return { ok: true, url };
}

export function assertSafeProviderUrl(raw: string, opts: UrlGuardOptions = {}): URL {
  const result = inspectProviderUrl(raw, opts);
  if (!result.ok || !result.url) {
    throw new GatewayError('invalid_request', `Rejected provider base URL. ${result.reason ?? ''}`.trim(), {
      details: { reason: result.reason },
    });
  }
  return result.url;
}

function matchesAllowlist(host: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    const pattern = entry.toLowerCase().trim();
    if (!pattern) continue;
    if (pattern === host) return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".internal"
      if (host.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * Literal-address check.
 *
 * Note the limitation honestly: this inspects the hostname as written. A
 * hostname that DNS later resolves to a private address is not caught here.
 * Deployments that need that guarantee should pair this with an egress proxy
 * or a DNS-pinning HTTP agent; see docs/security.md.
 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);

  // Decimal / octal / hex encodings of an IPv4 address, e.g. `2130706433`.
  if (/^\d+$/.test(host)) {
    const asInt = Number(host);
    if (Number.isSafeInteger(asInt) && asInt <= 0xffffffff) {
      return isPrivateIpv4(intToIpv4(asInt));
    }
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const asInt = Number.parseInt(host, 16);
    if (Number.isSafeInteger(asInt) && asInt <= 0xffffffff) {
      return isPrivateIpv4(intToIpv4(asInt));
    }
  }
  return false;
}

function intToIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lowered = ip.toLowerCase();
  if (lowered === '::1' || lowered === '::') return true;
  if (lowered.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(lowered)) return true; // unique local
  // IPv4-mapped addresses inherit the v4 verdict. WHATWG URL parsing rewrites
  // `::ffff:127.0.0.1` to `::ffff:7f00:1`, so both spellings are handled.
  const dotted = lowered.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return isPrivateIpv4(dotted[1]);
  const hex = lowered.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1] ?? '0', 16);
    const low = Number.parseInt(hex[2] ?? '0', 16);
    return isPrivateIpv4(intToIpv4(((high << 16) | low) >>> 0));
  }
  return false;
}
