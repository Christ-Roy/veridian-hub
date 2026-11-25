/**
 * Helper d'authentification + rate-limit pour les routes admin Hub.
 *
 * Centralise :
 *  - check x-admin-secret (timing-safe via crypto.timingSafeEqual)
 *  - session d'un administrateur de plateforme (lib/admin/session-admin.ts)
 *  - rate-limit IP via adminApiLimiter (30/min/IP) en défense en profondeur
 *
 * Sans ce helper, chaque route admin re-duplique ~20 lignes d'auth/rate
 * et risque la divergence sécu (ex: une route oublie de check rate).
 */

import { NextRequest, NextResponse } from 'next/server';

import { refusAdmin, secretAdminValide } from '@/lib/admin/require-admin';
import { sessionAdmin } from '@/lib/admin/session-admin';
import { adminApiLimiter, extractClientIp } from '@/lib/auth/rate-limit';

export type AdminAuthSuccess = {
  ok: true;
  sessionEmail: string | null; // null si auth via x-admin-secret
  /** L'administrateur, par son identité du Hub ; null par `x-admin-secret`. */
  hubUserId?: string | null;
};

export type AdminAuthDenied = { ok: false; response: NextResponse };

export async function authenticateAdmin(
  request: NextRequest
): Promise<AdminAuthSuccess | AdminAuthDenied> {
  // 1. Rate-limit IP (défense en profondeur — utile contre brute-force secret + spam)
  //
  // `enforceWithBypass` : si le header `x-veridian-e2e-bypass-ratelimit`
  // est valide ET DEPLOY_ENV !== 'prod' → la requête passe gratuitement,
  // un audit log `[ratelimit-bypass]` est émis côté RateLimiter (unique
  // par requête, pas de double-log). En prod le bypass est court-circuité
  // par `shouldBypassRateLimit()` → comportement strictement identique
  // au legacy `enforce(ip)`.
  const ip = extractClientIp(request.headers);
  const rate = adminApiLimiter.enforceWithBypass(ip, request.headers);
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

  // 2. x-admin-secret, en temps constant
  if (secretAdminValide(request.headers.get('x-admin-secret'))) return { ok: true, sessionEmail: null, hubUserId: null };

  // 3. Session d'un administrateur de plateforme
  const s = await sessionAdmin();
  return s.ok ? { ok: true, sessionEmail: s.email, hubUserId: s.hubUserId } : { ok: false, response: refusAdmin(s.raison) };
}
