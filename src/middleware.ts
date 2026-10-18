import { NextResponse, type NextRequest } from 'next/server';

/**
 * Global Edge Security Middleware
 * - Enforces CSRF / Same-Origin protections on mutative requests (POST, PUT, DELETE, PATCH).
 * - Tightens CORS settings and rejects unapproved cross-origin requests.
 * - Applies security response headers across all routes.
 */

// Webhooks and external callback endpoints that authenticate via cryptographic signatures rather than browser sessions
const CSRF_EXEMPT_PATHS = [
  '/api/cashfree/webhook',
  '/api/cron/',
  '/api/ping',
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  // 1. CSRF Protection for state-mutating requests
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const isExempt = CSRF_EXEMPT_PATHS.some(path => pathname.startsWith(path));

    if (!isExempt) {
      // Reject cross-site requests signaled by modern browser Sec-Fetch-Site header
      const secFetchSite = req.headers.get('sec-fetch-site');
      if (secFetchSite && secFetchSite === 'cross-site') {
        return NextResponse.json(
          { success: false, error: 'Forbidden: Cross-site request blocked by CSRF policy.' },
          { status: 403 }
        );
      }

      // Check Origin / Referer header match
      const origin = req.headers.get('origin');
      const referer = req.headers.get('referer');
      const source = origin || referer;

      if (source) {
        try {
          const sourceHost = new URL(source).host.toLowerCase();
          const hostHeader = (
            req.headers.get('x-forwarded-host') ||
            req.headers.get('host') ||
            req.nextUrl.host
          ).toLowerCase().split(',')[0].trim();

          const isLocalhost = sourceHost.includes('localhost') && hostHeader.includes('localhost');
          const isRunApp = sourceHost.endsWith('.run.app') && hostHeader.endsWith('.run.app');
          const isHostMatch = sourceHost === hostHeader;

          if (!isHostMatch && !isLocalhost && !isRunApp) {
            return NextResponse.json(
              { success: false, error: 'Forbidden: Request origin does not match target host.' },
              { status: 403 }
            );
          }
        } catch {
          return NextResponse.json(
            { success: false, error: 'Forbidden: Malformed request origin.' },
            { status: 403 }
          );
        }
      }
    }
  }

  // 2. Response with strict security headers
  const res = NextResponse.next();

  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'SAMEORIGIN');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return res;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.*\\.xml|robots\\.txt).*)',
  ],
};
