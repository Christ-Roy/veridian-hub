/**
 * GET /api/gmail/connect/callback
 *
 * Reçoit le code OAuth Google après consent. Étapes :
 *   1. Vérifie session user (sinon login).
 *   2. Vérifie state CSRF (cookie posé par /api/gmail/connect).
 *   3. Échange code → tokens (access + refresh + id_token).
 *   4. Vérifie que l'email Google connecté matche l'email Hub (sécurité —
 *      empêche un user de connecter le Gmail de quelqu'un d'autre par
 *      accident ou attaque social engineering). En cas de mismatch :
 *      redirect avec error=email_mismatch.
 *   5. Upsert hub_app.accounts :
 *        provider='google',
 *        providerAccountId=sub,
 *        refresh_token, access_token, expires_at,
 *        scope=basic Auth.js scopes,
 *        mailSendScope=scopes effectifs (contient gmail.send),
 *        mailSendNeedsReauth=false (reset).
 *      Important : pour un Account qui existe déjà (sign-in Google
 *      antérieur), on UPDATE plutôt que CREATE — on étend les scopes.
 *   6. Redirige vers /dashboard/settings/mail?status=connected (ou la
 *      `return` URL stockée en cookie si elle existe).
 *
 * En cas d'erreur OAuth (?error=access_denied de Google), redirige
 * /dashboard/settings/mail?status=denied.
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import { prisma } from '@/lib/prisma';
import { exchangeMailCode } from '@/lib/mail/gmail-oauth';
import {
  STATE_COOKIE,
  RETURN_COOKIE,
  buildRedirectUri,
  getHubBaseUrl,
  validateReturnUrl,
} from '@/lib/mail/oauth-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildReturnRedirect(
  baseUrl: URL,
  status: 'connected' | 'denied' | 'invalid_state' | 'oauth_failed' | 'email_mismatch',
  returnPath: string | undefined,
): URL {
  // Le cookie RETURN_COOKIE a déjà été validé à la pose (connect/route.ts),
  // mais on re-valide ici en défense en profondeur : un cookie ne doit
  // jamais déclencher un redirect vers un host hors allowlist, même altéré.
  const safeReturn = validateReturnUrl(returnPath);
  if (safeReturn !== '') {
    // `new URL(safeReturn, baseUrl)` : si safeReturn est absolu (cross-domain
    // app downstream), baseUrl est ignoré ; si relatif (interne Hub), il sert
    // de base. Dans les deux cas on annonce le résultat via `mail_status`.
    const ret = new URL(safeReturn, baseUrl);
    ret.searchParams.set('mail_status', status);
    return ret;
  }
  const fallback = new URL('/dashboard/settings/mail', baseUrl);
  fallback.searchParams.set('status', status);
  return fallback;
}

export async function GET(request: NextRequest) {
  // url : utilisé pour parser les searchParams (code, state, error)
  const url = new URL(request.url);
  // baseUrl : utilisé pour construire tous les redirect vers le Hub
  // (force NEXT_PUBLIC_SITE_URL pour éviter 0.0.0.0:3000 derrière Traefik).
  const baseUrl = getHubBaseUrl(request.url);

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL('/login', baseUrl));
  }

  const returnPath = request.cookies.get(RETURN_COOKIE)?.value;
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;

  // Google retourne ?error=access_denied si l'user refuse le consent.
  const googleError = url.searchParams.get('error');
  if (googleError) {
    const res = NextResponse.redirect(
      buildReturnRedirect(baseUrl, 'denied', returnPath),
    );
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(RETURN_COOKIE);
    return res;
  }

  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');

  if (!code || !stateParam) {
    return NextResponse.json(
      { error: 'missing_code_or_state' },
      { status: 400 },
    );
  }

  if (!cookieState || cookieState !== stateParam) {
    const res = NextResponse.redirect(
      buildReturnRedirect(baseUrl, 'invalid_state', returnPath),
    );
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(RETURN_COOKIE);
    return res;
  }

  // buildRedirectUri lit déjà NEXT_PUBLIC_SITE_URL en priorité (cf
  // oauth-cookies.ts) — on passe le fallback origin par sécurité.
  const fallbackOrigin = `${url.protocol}//${url.host}`;
  const redirectUri = buildRedirectUri(fallbackOrigin);

  let tokens;
  try {
    tokens = await exchangeMailCode(code, redirectUri);
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: '[mail-oauth]',
        msg: 'exchange_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const res = NextResponse.redirect(
      buildReturnRedirect(baseUrl, 'oauth_failed', returnPath),
    );
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(RETURN_COOKIE);
    return res;
  }

  // Sécurité : l'email Google connecté DOIT matcher l'email Hub. Sinon on
  // refuse silencieusement plutôt que de lier un Account orphelin.
  if (tokens.email.toLowerCase() !== user.email.toLowerCase()) {
    console.warn(
      JSON.stringify({
        tag: '[mail-oauth]',
        msg: 'email_mismatch',
        hub_email: user.email,
        google_email: tokens.email,
        user_id: user.id,
      }),
    );
    const res = NextResponse.redirect(
      buildReturnRedirect(baseUrl, 'email_mismatch', returnPath),
    );
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(RETURN_COOKIE);
    return res;
  }

  // Upsert Account — si l'user a déjà un sign-in Google, on étend les
  // scopes du même Account (providerAccountId = sub Google stable).
  // expires_at en SECONDS (norme adapter Prisma Auth.js).
  const expiresAtSec = Math.floor(tokens.expires_at / 1000);

  await prisma.account.upsert({
    where: {
      provider_providerAccountId: {
        provider: 'google',
        providerAccountId: tokens.sub,
      },
    },
    update: {
      // L'Account existe déjà (sign-in basic Google) → on étend pour
      // ajouter le scope gmail.send. On garde le userId actuel (ne pas
      // overwrite avec un autre user au cas où l'admin a impersonné).
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: expiresAtSec,
      id_token: tokens.id_token,
      // `scope` Auth.js = basic scopes ; `mailSendScope` = scopes effectifs
      // élargis pour Mail Sender. On garde les 2 distincts.
      mailSendScope: tokens.granted_scope,
      mailSendNeedsReauth: false,
    },
    create: {
      userId: user.id,
      type: 'oauth',
      provider: 'google',
      providerAccountId: tokens.sub,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: expiresAtSec,
      id_token: tokens.id_token,
      token_type: 'Bearer',
      scope: 'openid email profile',
      mailSendScope: tokens.granted_scope,
      mailSendNeedsReauth: false,
    },
  });

  const res = NextResponse.redirect(
    buildReturnRedirect(baseUrl, 'connected', returnPath),
  );
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(RETURN_COOKIE);
  return res;
}
