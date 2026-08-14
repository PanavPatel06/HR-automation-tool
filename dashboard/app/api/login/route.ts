import { NextResponse } from 'next/server';
import { checkPassword, mintSession, COOKIE, SESSION_MAX_AGE } from '../../../lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let password = '';
  try { ({ password } = await req.json()); } catch { /* empty body */ }

  if (!process.env.DASHBOARD_PASSWORD || !process.env.SESSION_SECRET) {
    return NextResponse.json(
      { message: 'Sign-in is not configured: DASHBOARD_PASSWORD and SESSION_SECRET must both be set.' },
      { status: 500 },
    );
  }

  if (!checkPassword(password)) {
    // A deliberate delay blunts online guessing without needing a rate limiter.
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ message: 'Incorrect password.' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, mintSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
