import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'aigw_admin_key';
const GATEWAY_COOKIE = 'aigw_gateway_url';

export interface DashboardSession {
  apiKey: string;
  gatewayUrl: string;
  /** How the credential was obtained, surfaced in the UI so it is never a mystery. */
  source: 'cookie' | 'environment';
}

/**
 * Dashboard authentication.
 *
 * The dashboard is a client of the gateway's admin API, not a second reader of
 * its database. That keeps one source of truth and lets the dashboard point at
 * a remote gateway.
 *
 * Two credential paths:
 *   - an httpOnly, SameSite=Lax cookie the operator sets on /connect
 *   - AI_GATEWAY_ADMIN_KEY in the environment, for a single-tenant deployment
 *
 * Clerk is supported for *who may open the dashboard* (see `clerkConfigured`);
 * the gateway itself is always reached with an API key, because the gateway has
 * no notion of a browser session and should not grow one.
 */
export async function getSession(): Promise<DashboardSession | null> {
  const envKey = process.env.AI_GATEWAY_ADMIN_KEY;
  const envUrl = process.env.GATEWAY_URL ?? 'http://localhost:8787';

  const store = await cookies();
  const cookieKey = store.get(SESSION_COOKIE)?.value;
  const cookieUrl = store.get(GATEWAY_COOKIE)?.value;

  if (cookieKey) {
    return { apiKey: cookieKey, gatewayUrl: cookieUrl ?? envUrl, source: 'cookie' };
  }
  if (envKey) {
    return { apiKey: envKey, gatewayUrl: envUrl, source: 'environment' };
  }
  return null;
}

export async function setSession(apiKey: string, gatewayUrl: string): Promise<void> {
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  store.set(SESSION_COOKIE, apiKey, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  store.set(GATEWAY_COOKIE, gatewayUrl, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(GATEWAY_COOKIE);
}

/** True when Clerk is configured to gate access to the dashboard itself. */
export function clerkConfigured(): boolean {
  return !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

export function defaultGatewayUrl(): string {
  return process.env.GATEWAY_URL ?? 'http://localhost:8787';
}
