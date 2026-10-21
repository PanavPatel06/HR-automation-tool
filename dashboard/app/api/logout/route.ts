import { NextResponse } from 'next/server';
import { COOKIE } from '../../../lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // The request URL may be the app server's internal localhost URL when it is
  // behind a reverse proxy. A relative Location keeps the browser on the
  // public host that submitted the sign-out form.
  const res = new NextResponse(null, {
    status: 303,
    headers: { Location: '/login', 'Cache-Control': 'no-store' },
  });
  res.cookies.set(COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });
  return res;
}
