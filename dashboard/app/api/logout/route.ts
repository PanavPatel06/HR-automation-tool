import { NextResponse } from 'next/server';
import { COOKIE } from '../../../lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  res.cookies.set(COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
