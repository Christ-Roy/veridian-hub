// Auth.js v5 catch-all route handler.
// Gère tous les endpoints /api/auth/* : signin, signout, callback, session, csrf...
//
// Note : coexiste avec les routes Supabase Auth legacy qui vivent ailleurs
// (app/(auth)/auth/callback, etc.). Auth.js ne touche qu'à /api/auth/*.
//
// Wrap des handlers Auth.js avec un rate-limiter IP-based : protège
// /api/auth/signin (start OAuth) et /api/auth/callback contre spam/bot.
// Les autres routes Auth.js (session, csrf, providers) ne sont PAS
// limitées (appelées légitimement plusieurs fois par page render).

import { handlers } from '@/auth';
import {
  oauthStartLimiter,
  oauthCallbackLimiter,
  extractClientIp,
} from '@/lib/auth/rate-limit';
import { NextRequest, NextResponse } from 'next/server';

function pickLimiter(pathname: string) {
  // Pathname typique : /api/auth/signin, /api/auth/signin/google,
  // /api/auth/callback, /api/auth/callback/microsoft-entra-id...
  if (pathname.startsWith('/api/auth/signin')) return oauthStartLimiter;
  if (pathname.startsWith('/api/auth/callback')) return oauthCallbackLimiter;
  return null;
}

function makeTooManyResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: 'rate_limited',
      message: "Trop de tentatives. Patientez avant de réessayer.",
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSeconds),
      },
    }
  );
}

async function withRateLimit(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<Response>
): Promise<Response> {
  const url = new URL(req.url);
  const limiter = pickLimiter(url.pathname);
  if (!limiter) {
    return handler(req);
  }
  const ip = extractClientIp(req.headers);
  const result = limiter.enforce(ip);
  if (!result.ok) {
    console.warn(
      JSON.stringify({
        tag: '[auth-ratelimit]',
        level: 'warn',
        path: url.pathname,
        ip,
        retry_after_s: result.retryAfterSeconds,
        ts: new Date().toISOString(),
      })
    );
    return makeTooManyResponse(result.retryAfterSeconds);
  }
  return handler(req);
}

const { GET: rawGET, POST: rawPOST } = handlers;

export async function GET(req: NextRequest) {
  return withRateLimit(req, rawGET);
}

export async function POST(req: NextRequest) {
  return withRateLimit(req, rawPOST);
}
