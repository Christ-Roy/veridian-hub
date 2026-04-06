import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

export const createClient = (request: NextRequest) => {
  // Create an unmodified response
  let response = NextResponse.next({
    request: {
      headers: request.headers
    }
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          // If the cookie is updated, update the cookies for the request and response
          request.cookies.set({
            name,
            value,
            ...options
          });
          response = NextResponse.next({
            request: {
              headers: request.headers
            }
          });
          response.cookies.set({
            name,
            value,
            ...options
          });
        },
        remove(name: string, options: CookieOptions) {
          // If the cookie is removed, update the cookies for the request and response
          request.cookies.set({
            name,
            value: '',
            ...options
          });
          response = NextResponse.next({
            request: {
              headers: request.headers
            }
          });
          response.cookies.set({
            name,
            value: '',
            ...options
          });
        }
      }
    }
  );

  return { supabase, response };
};

export const updateSession = async (request: NextRequest) => {
  const path = request.nextUrl.pathname;

  try {
    const { supabase, response } = createClient(request);

    // Skip auth check for static assets, images, fonts, and API endpoints
    if (
      path.startsWith('/_next/') ||
      path.startsWith('/api/health') ||
      path.startsWith('/favicon.ico') ||
      path.startsWith('/images/') ||
      path.startsWith('/fonts/') ||
      path.startsWith('/static/') ||
      path.match(/\.(css|js|png|jpg|jpeg|svg|ico|webp|woff|woff2|ttf|eot)$/)
    ) {
      return response;
    }

    // Check for existing Supabase cookies
    const supabaseCookies = request.cookies.getAll().filter(c => c.name.startsWith('sb-'));

    // This will refresh session if expired - required for Server Components
    const { data, error } = await supabase.auth.getUser();

    // Only clear cookies if tokens are INVALID, not if rate limited
    if (error && supabaseCookies.length > 0) {
      const isRateLimited = error.status === 429;
      const isInvalidToken =
        error.message?.includes('refresh_token_not_found') ||
        error.message?.includes('invalid_grant') ||
        error.message?.includes('Invalid Refresh Token') ||
        error.message?.includes('JWT') ||
        error.status === 401;

      if (isRateLimited) {
        // Rate limited: Check retry count to avoid infinite loops
        const retryCount = parseInt(request.cookies.get('sb-rate-limit-retry')?.value || '0');

        if (retryCount >= 3) {
          // After 3 rate-limited retries, clear cookies (likely dead tokens causing spam)
          console.warn(`[Middleware] Rate limited ${retryCount} times on ${path} - clearing cookies to stop spam`);
          supabaseCookies.forEach((cookie) => {
            response.cookies.delete(cookie.name);
          });
          response.cookies.delete('sb-rate-limit-retry');
        } else {
          // Increment retry counter
          console.warn(`[Middleware] Rate limited on ${path} - retry ${retryCount + 1}/3`);
          response.cookies.set('sb-rate-limit-retry', String(retryCount + 1), {
            maxAge: 60, // 1 minute TTL
            httpOnly: true,
            sameSite: 'lax'
          });
        }
      } else if (isInvalidToken) {
        // Invalid token: Clear cookies to prevent retry loops
        console.warn(`[Middleware] Invalid token detected on ${path} - clearing ${supabaseCookies.length} cookies:`, supabaseCookies.map(c => c.name).join(', '));

        supabaseCookies.forEach((cookie) => {
          response.cookies.delete(cookie.name);
        });
        response.cookies.delete('sb-rate-limit-retry');

        console.warn(`[Middleware] Cleared cookies to prevent retry loop`);
      } else {
        // Unknown auth error: Log it for debugging
        console.error(`[Middleware] Auth error on ${path} (${error.status}):`, error.message);
      }
    } else if (data?.user) {
      // Successful auth: Clear retry counter
      response.cookies.delete('sb-rate-limit-retry');
    }

    return response;
  } catch (e) {
    console.error('[Middleware] Failed to create Supabase client:', e);
    return NextResponse.next({
      request: {
        headers: request.headers
      }
    });
  }
};
