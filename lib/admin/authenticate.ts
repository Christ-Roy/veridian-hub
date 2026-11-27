/**
 * LE gardien des routes d'administration du Hub (`app/api/admin/**`). Un seul : `requireAdmin` ne fait plus que lui déléguer (2026-11-27).
 *
 * Dans l'ordre, chaque refus reste un refus :
 *  1. limite de débit par IP (`adminApiLimiter`, 30 ÉCHECS/min) : une IP au plafond est refusée avant même la clé ; seul un échec compte (27/11 :
 *     compter les appels réussis renvoyait des 429 au CLI `hub` et à la batterie, qui enchaînent des dizaines d'appels admin par minute) ;
 *  2. `x-admin-secret` en temps constant (outils `hub`, batterie). Refusé si `sessionSeule` : la clé n'entre jamais dans une route à session seule ;
 *  3. session d'un administrateur de plateforme (`sessionAdmin`) : identité relue en base, adresse prouvée, connexion réelle de moins de 24 h,
 *     jamais une session empruntée ni une session ouverte par le fournisseur d'une organisation.
 *
 * Le contrôle d'origine et le journal restent dans la route (ils dépendent de l'action), jamais dans un second gardien.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { sessionAdmin, type SessionAdmin } from '@/lib/admin/session-admin';
import { adminApiLimiter, extractClientIp, shouldBypassRateLimit, type RateLimitResult } from '@/lib/auth/rate-limit';

export type AdminAuthSuccess = {
  ok: true;
  sessionEmail: string | null; // null si auth via x-admin-secret
  /** L'administrateur, par son identité du Hub ; null par `x-admin-secret`. */
  hubUserId?: string | null;
  /** La session d'administrateur (lue par le gardien, pas une seconde fois) ; absent si la clé a passé. */
  admin?: { userId: string; hubUserId: string; email: string };
};

export type AdminAuthDenied = { ok: false; response: NextResponse };

export type AdminAuthOptions = {
  /** Vrai : seule une session d'administrateur passe, jamais `x-admin-secret` (ex. entrer chez un client). */
  sessionSeule?: boolean;
};

/** Le même refus partout : le corps dit quoi faire, jamais si le compte existe. */
export function refusAdmin(raison: Extract<SessionAdmin, { ok: false }>['raison']): NextResponse {
  if (raison === 'non_connecte') return NextResponse.json({ error: 'unauthorized', message: 'Provide x-admin-secret or authenticate.' }, { status: 401 });
  if (raison === 'preuve_ancienne') return NextResponse.json({ error: 'recent_auth_required', login_url: '/login?reauth=1' }, { status: 403 });
  if (raison === 'emprunt') return NextResponse.json({ error: 'forbidden', message: 'Impersonated session has no admin access.' }, { status: 403 });
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}

/** Comparaison en temps constant ; sans secret posé, rien ne passe. */
export function secretAdminValide(fourni: string | null): boolean {
  const attendu = process.env.ADMIN_SECRET;
  if (!attendu || !fourni) return false;
  const a = Buffer.from(fourni);
  const b = Buffer.from(attendu);
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function authenticateAdmin(
  request: NextRequest | Request,
  options: AdminAuthOptions = {}
): Promise<AdminAuthSuccess | AdminAuthDenied> {
  // 1. Limite par IP, sur les échecs seulement. Contournement e2e : en-tête `x-veridian-e2e-bypass-ratelimit` valide ET DEPLOY_ENV !== 'prod'.
  const ip = extractClientIp(request.headers);
  const contourne = shouldBypassRateLimit(request.headers);
  const trop = (rate: Extract<RateLimitResult, { ok: false }>) => {
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
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      ),
    } as AdminAuthDenied;
  };
  const plein = contourne ? null : (await adminApiLimiter.depasse(ip));
  if (plein && !plein.ok) return trop(plein);
  // Un échec compte ; le plafond franchi par cet échec rend le 429.
  const echec = async (refus: NextResponse): Promise<AdminAuthDenied> => {
    if (contourne) return { ok: false, response: refus };
    const r = (await adminApiLimiter.enforce(ip));
    return r.ok ? { ok: false, response: refus } : trop(r);
  };

  // 2. x-admin-secret, en temps constant (jamais pour une route à session seule)
  const cle = request.headers.get('x-admin-secret');
  if (!options.sessionSeule && secretAdminValide(cle)) {
    return { ok: true, sessionEmail: null, hubUserId: null };
  }

  // 3. Session d'un administrateur de plateforme. Une clé fausse fournie compte comme un échec même si une session passe ensuite.
  const s = await sessionAdmin();
  if (!s.ok) return echec(refusAdmin(s.raison));
  if (cle && !options.sessionSeule) (await adminApiLimiter.enforce(ip));
  return { ok: true, sessionEmail: s.email, hubUserId: s.hubUserId, admin: { userId: s.userId, hubUserId: s.hubUserId, email: s.email } };
}
