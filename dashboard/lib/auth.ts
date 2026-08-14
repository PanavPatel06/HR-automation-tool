import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * A shared-password gate with a signed session cookie.
 *
 * This is deliberately the simplest thing that is actually secure for a small
 * internal team: no OAuth app to register, no extra dependency, nothing to pay
 * for. It authenticates the TEAM, not the individual — so `approved_by` records
 * "dashboard" rather than a person.
 *
 * Upgrade path when you need per-user attribution or offboarding: swap this for
 * NextAuth with the Google provider and an email allowlist. See
 * dashboard/README.md.
 */

export const COOKIE = 'hr_session';
const MAX_AGE_SEC = 60 * 60 * 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set. Generate one with: openssl rand -hex 32');
  return s;
}

export function mintSession(now = Date.now()): string {
  const expires = Math.floor(now / 1000) + MAX_AGE_SEC;
  const mac = createHmac('sha256', secret()).update(String(expires)).digest('hex');
  return `${expires}.${mac}`;
}

export function isValidSession(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [expiresRaw, mac] = token.split('.');
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || !mac) return false;
  if (expires < Math.floor(now / 1000)) return false;

  const expected = createHmac('sha256', secret()).update(String(expires)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time password comparison, so the check cannot be timed. */
export function checkPassword(candidate: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(createHmac('sha256', secret()).update(expected).digest('hex'));
  const b = Buffer.from(createHmac('sha256', secret()).update(candidate ?? '').digest('hex'));
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireSession(): Promise<boolean> {
  const jar = await cookies();
  return isValidSession(jar.get(COOKIE)?.value);
}

export const SESSION_MAX_AGE = MAX_AGE_SEC;
