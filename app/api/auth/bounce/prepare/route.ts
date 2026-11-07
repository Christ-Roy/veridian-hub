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

import { listSupportedApps } from '@/lib/auth/bounce-apps';
import {
  isRealNavigation,
  parseNext,
  signNextCookie,
  nextCookieName,
  shouldUseSecureCookie,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
  NEXT_COOKIE_TTL_MS,
} from '@/lib/auth/bounce-next';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';

const AUTO_BOUNCE_COOKIE = 'veridian-auto-bounce';
const AUTO_BOUNCE_MAX = 2;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isRealNavigation(req)) {
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(req.url);
  const nextRaw = url.searchParams.get('next');
  const deployEnv = process.env.DEPLOY_ENV;
  const secret = process.env.AUTH_SECRET;

  // Base URL publique : derrière Traefik, req.url vaut https://0.0.0.0:3000.
  // getHubBaseUrl force NEXT_PUBLIC_SITE_URL (cf lib/mail/oauth-cookies.ts).
  const baseUrl = getHubBaseUrl(req.url);
  const loginUrl = new URL('/login', baseUrl);

  const candidate = parseNext(nextRaw, deployEnv);
  // Seule une app déclarée est une cible : `<client>.veridian.site` passe le motif, pas ce filtre.
  const parsed = candidate && listSupportedApps().includes(candidate.app) ? candidate : null;

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

  // Anti-boucle : un retour automatique d'app (`auto=1`) qui revient ici trop vite a échoué. Plus
  // de rebond silencieux, on montre la connexion ; l'app en fait autant de son côté (§6bis.9).
  const auto = url.searchParams.get('auto') === '1';
  // Compté par app : ouvrir trois outils à la suite n'est pas une boucle.
  const [appDuCompteur, compteur] = (req.cookies.get(AUTO_BOUNCE_COOKIE)?.value ?? '').split(':');
  const essais = appDuCompteur === parsed.app ? Number(compteur) || 0 : 0;
  if (auto && essais >= AUTO_BOUNCE_MAX) {
    const stop = new URL('/login', baseUrl);
    stop.searchParams.set('bounce_failed', '1');
    return NextResponse.redirect(stop);
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
  if (auto) {
    response.cookies.set({
      name: AUTO_BOUNCE_COOKIE,
      value: `${parsed.app}:${essais + 1}`,
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api/auth/bounce',
      maxAge: 60,
    });
  }
  // Nettoie l'autre nom de cookie au cas où (dev↔prod switch).
  response.cookies.delete(
    secure ? NEXT_COOKIE_NAME_INSECURE : NEXT_COOKIE_NAME_SECURE,
  );

  return response;
}
