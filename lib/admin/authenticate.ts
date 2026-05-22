/**
 * Helper d'authentification + rate-limit pour les routes admin Hub.
 *
 * Centralise :
 *  - check x-admin-secret (timing-safe via crypto.timingSafeEqual)
 *  - fallback session Auth.js + isPlatformAdmin
 *  - rate-limit IP via adminApiLimiter (30/min/IP) en défense en profondeur
 *
 * Sans ce helper, chaque route admin re-duplique ~20 lignes d'auth/rate
 * et risque la divergence sécu (ex: une route oublie de check rate).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { adminApiLimiter, extractClientIp } from '@/lib/auth/rate-limit';

export type AdminAuthSuccess = {
  ok: true;
  sessionEmail: string | null; // null si auth via x-admin-secret
};

export type AdminAuthDenied = { ok: false; response: NextResponse };

/**
 * Comparaison timing-safe d'un secret. Évite les timing attacks théoriques
 * (impossibles en pratique sur Internet à cause du jitter, mais standard
 * industriel — coût négligeable).
 */
function secretsEqual(a: string, b: string): boolean {
  // timingSafeEqual exige des Buffers de même longueur — sinon throw.
  // On padd les 2 strings à la même longueur pour ne pas révéler la length
  // du secret stocké via timing.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Évite throw + fait quand même un compare pour normaliser le timing
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export async function authenticateAdmin(
  request: NextRequest
): Promise<AdminAuthSuccess | AdminAuthDenied> {
  // 1. Rate-limit IP (défense en profondeur — utile contre brute-force secret + spam)
  const ip = extractClientIp(request.headers);
  const rate = adminApiLimiter.enforce(ip);
  if (!rate.ok) {
    console.warn(
      JSON.stringify({
        tag: '[admin-ratelimit]',
        level: 'warn',
        path: new URL(request.url).pathname,
        ip,
        retry_after_s: rate.retryAfterSeconds,
        ts: new Date().toISOString(),
      })
    );
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'rate_limited', message: 'Trop de tentatives. Patientez avant de réessayer.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rate.retryAfterSeconds) },
        }
      ),
    };
  }

  // 2. Check x-admin-secret en timing-safe
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');
  if (adminSecret && headerSecret && secretsEqual(headerSecret, adminSecret)) {
    return { ok: true, sessionEmail: null };
  }

  // 3. Fallback session Auth.js
  const session = await auth();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'unauthorized', message: 'Provide x-admin-secret or authenticate.' },
        { status: 401 }
      ),
    };
  }
  if (!isPlatformAdmin(session.user)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }
  // Anti-ré-impersonation : une session impersonée NE doit jamais accéder à
  // une route admin, même si l'email impersoné est dans la whitelist admin.
  // Sinon un admin impersonant un autre admin élèverait à nouveau ses droits.
  if (isImpersonatedSession(session)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'forbidden', message: 'Impersonated session has no admin access.' },
        { status: 403 }
      ),
    };
  }
  return { ok: true, sessionEmail: session.user.email ?? null };
}
