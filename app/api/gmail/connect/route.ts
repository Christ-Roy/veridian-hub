/**
 * GET /api/gmail/connect
 *
 * Démarre le flow OAuth Mail Sender (Client OAuth Google #2 — distinct du
 * sign-in Hub). L'user doit être loggué (session Auth.js). On :
 *   1. Génère un state CSRF random (32 bytes hex).
 *   2. Stocke le state dans un cookie signé HttpOnly + SameSite=Lax,
 *      TTL 10 min — vérifié au retour sur /api/gmail/connect/callback.
 *   3. Stocke aussi `return` (URL relative de retour) pour permettre à
 *      l'app downstream d'initier le flow puis revenir à sa propre UI.
 *   4. Redirige 302 vers l'URL de consent Google avec scopes gmail.send +
 *      access_type=offline + prompt=consent.
 *
 * En cas de mauvaise config (ENV missing), répond 503 plutôt que 500.
 */

import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import { getMailAuthUrl } from '@/lib/mail/gmail-oauth';
import {
  STATE_COOKIE,
  RETURN_COOKIE,
  STATE_TTL_SECONDS,
  buildRedirectUri,
  getHubBaseUrl,
  validateReturnUrl,
} from '@/lib/mail/oauth-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // baseUrl : force NEXT_PUBLIC_SITE_URL pour éviter 0.0.0.0:3000 derrière
  // Traefik (sinon NextResponse.redirect → ERR_ADDRESS_INVALID côté browser).
  const baseUrl = getHubBaseUrl(request.url);

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', baseUrl));
  }

  // ─── Optional `return` param : URL de retour côté app downstream.
  // Deux formes acceptées (cf validateReturnUrl) :
  //   - path relatif interne Hub (ex: ?return=/settings/mail-account)
  //   - URL absolue HTTPS cross-domain dont le host ∈ allowlist apps
  //     Veridian (ex: Notifuse envoie
  //     ?return=https://notifuse.app.veridian.site/console/...).
  // Tout host hors allowlist ou protocole non-HTTPS → '' (anti open-redirect).
  const url = new URL(request.url);
  const safeReturn = validateReturnUrl(url.searchParams.get('return'));

  const state = randomBytes(32).toString('hex');
  // origin pour cookies secure flag + fallback buildRedirectUri (qui lit
  // NEXT_PUBLIC_SITE_URL en priorité, cf oauth-cookies.ts).
  const origin = `${baseUrl.protocol}//${baseUrl.host}`;
  const redirectUri = buildRedirectUri(origin);

  let consentUrl: string;
  try {
    consentUrl = getMailAuthUrl(state, redirectUri);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'mail_oauth_not_configured',
        message: err instanceof Error ? err.message : 'OAuth client not configured',
      },
      { status: 503 },
    );
  }

  const res = NextResponse.redirect(consentUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: origin.startsWith('https://'),
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/api/gmail/connect',
  });
  res.cookies.set(RETURN_COOKIE, safeReturn, {
    httpOnly: true,
    secure: origin.startsWith('https://'),
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/api/gmail/connect',
  });
  return res;
}

