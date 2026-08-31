import { NextResponse, type NextRequest } from 'next/server';

/**
 * Gate every page and API route behind the session cookie.
 *
 * The cookie's signature is verified in route handlers and pages (Node
 * runtime); middleware only checks for presence, because the Edge runtime has
 * no node:crypto. Presence alone is not authentication — it is a cheap redirect
 * for logged-out users, and every real check happens server-side.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // /brand/* is deliberately public: it holds the logo the email templates
  // point at, and mail clients fetch that anonymously — behind the session
  // gate it would reach candidates as a broken image. Put nothing else there.
  if (pathname.startsWith('/login') || pathname.startsWith('/api/login') || pathname.startsWith('/_next') || pathname.startsWith('/brand/')) {
    return NextResponse.next();
  }
  if (!req.cookies.get('hr_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
