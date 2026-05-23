/**
 * GET /api/auth/bounce/prepare?next=<encoded_url>
 *
 * Étape 1 du flow Couche 4 (cf. `docs/CONTRAT-HUB.md` §6bis.8.2) :
 *  - Parse `?next=`, valide contre la whitelist regex.
 *  - Signe + pose le cookie `__Secure-veridian-next` (HMAC AUTH_SECRET, TTL 10min).
 *  - Redirige vers `/login` (sans `?next=` pour éviter fuite Referer côté
 *    bouton OAuth — c'est l'intérêt du cookie).
 *
 * Pourquoi un Route Handler dédié et pas la page `/login` directement :
 *   Next.js 15 interdit `cookies().set()` dans un Server Component. Seules
 *   les Route Handlers et Server Actions peuvent muter les cookies. On passe
 *   donc par ce GET intermédiaire qui pose le cookie + redirige.
 *
 * Si `next` est absent / invalide / hors whitelist → redirect `/login`
 * directement (silently dropped + warn log).
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  parseNext,
  signNextCookie,
  nextCookieName,
  shouldUseSecureCookie,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
  NEXT_COOKIE_TTL_MS,
} from '@/lib/auth/bounce-next';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const nextRaw = url.searchParams.get('next');
  const deployEnv = process.env.DEPLOY_ENV;
  const secret = process.env.AUTH_SECRET;

  const loginUrl = new URL('/login', req.url);

  const parsed = parseNext(nextRaw, deployEnv);

  if (!parsed) {
    if (nextRaw) {
      console.warn(
        JSON.stringify({
          tag: '[bounce]',
          level: 'warn',
          msg: 'prepare: next ignored (invalid or off-whitelist)',
          next_preview: nextRaw.slice(0, 64),
          deploy_env: deployEnv,
          ts: new Date().toISOString(),
        })
      );
    }
    return NextResponse.redirect(loginUrl);
  }

  if (!secret) {
    console.error(
      JSON.stringify({
        tag: '[bounce][critical]',
        level: 'error',
        msg: 'prepare: AUTH_SECRET missing — cannot sign cookie',
        ts: new Date().toISOString(),
      })
    );
    // Refus net : pas de cookie, mais on continue le flow login normal.
    return NextResponse.redirect(loginUrl);
  }

  // Marque la page /login pour qu'elle sache qu'on est en mode bounce
  // (le cookie suffit en théorie, mais ce flag query permet à /login
  // d'afficher un copy spécial sans relire le cookie côté Server Component
  // — la lecture cookie a un coût et déclenche dynamic rendering).
  loginUrl.searchParams.set('mode', 'bounce');
  loginUrl.searchParams.set('app', parsed.app);

  const secure = shouldUseSecureCookie();
  const cookieValue = signNextCookie(parsed.url, secret);
  const cookieName = nextCookieName(secure);

  const response = NextResponse.redirect(loginUrl);
  response.cookies.set({
    name: cookieName,
    value: cookieValue,
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(NEXT_COOKIE_TTL_MS / 1000),
  });
  // Nettoie l'autre nom de cookie au cas où (dev↔prod switch).
  response.cookies.delete(
    secure ? NEXT_COOKIE_NAME_INSECURE : NEXT_COOKIE_NAME_SECURE,
  );

  return response;
}
