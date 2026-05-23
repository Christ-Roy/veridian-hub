/**
 * GET /api/auth/bounce/complete
 *
 * Étape finale du flow Couche 4 (cf. `docs/CONTRAT-HUB.md` §6bis.8.2 points 4-5).
 *
 * Landing post-OAuth Hub : le `callbackUrl` Auth.js force `/api/auth/bounce/complete`
 * quand on est en mode bounce. À ce stade :
 *  - L'OAuth Google / Microsoft a réussi (cookie session Hub posé).
 *  - Le cookie `__Secure-veridian-next` est encore présent (sameSite=Lax
 *    survit au callback OAuth).
 *
 * Ce handler :
 *  1. Lit + vérifie le cookie next signé.
 *  2. Valide qu'on a une session Hub (sinon → /login pour re-trigger).
 *  3. Appelle `POST <app>/api/sso/issue-magic-link` en HMAC, consomme le
 *     cookie, redirect 302 vers le magic link reçu.
 *  4. Gestion erreurs :
 *     - cookie absent / invalide → `/dashboard`
 *     - 400 user_not_in_app → `/dashboard?app=<app>&hint=signup`
 *     - 5xx / timeout / not_configured → `/auth/bounce/error?app=...&code=...`
 *
 * Pourquoi un Route Handler et pas un Server Component : Next.js 15 interdit
 * `cookies().set()`/`.delete()` dans un Server Component. On a besoin de
 * vider le cookie après usage (consommation atomique).
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth/get-user';
import {
  parseNext,
  verifyNextCookie,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
} from '@/lib/auth/bounce-next';
import { issueMagicLinkForApp, BounceError } from '@/lib/auth/bounce-apps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const deployEnv = process.env.DEPLOY_ENV;
  const secret = process.env.AUTH_SECRET;

  const cookieValueSecure = req.cookies.get(NEXT_COOKIE_NAME_SECURE)?.value;
  const cookieValueInsecure = req.cookies.get(NEXT_COOKIE_NAME_INSECURE)?.value;
  const cookieValue = cookieValueSecure ?? cookieValueInsecure ?? null;

  /**
   * Helper : applique sur la réponse la suppression des deux cookies bounce.
   * On le fait sur TOUTE réponse terminale pour garantir l'effacement
   * (anti-replay : un refresh ne doit pas re-bouncer).
   */
  const wipeCookies = (res: NextResponse): NextResponse => {
    res.cookies.delete(NEXT_COOKIE_NAME_SECURE);
    res.cookies.delete(NEXT_COOKIE_NAME_INSECURE);
    return res;
  };

  if (!secret) {
    console.error(
      JSON.stringify({
        tag: '[bounce][critical]',
        level: 'error',
        msg: 'complete: AUTH_SECRET missing',
        ts: new Date().toISOString(),
      })
    );
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', req.url)));
  }

  const next = verifyNextCookie(cookieValue, secret);
  if (!next) {
    // Pas de cookie ou expiré / signature invalide : pas de cible légitime.
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', req.url)));
  }

  const parsed = parseNext(next, deployEnv);
  if (!parsed) {
    // Cookie présent mais host plus dans la whitelist (cas pathologique :
    // deploy / env changed pendant le flow).
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', req.url)));
  }

  const user = await getCurrentUser();
  if (!user || !user.email) {
    // Pas de session : OAuth a échoué silencieusement. On garde le cookie
    // next pour relayer la prochaine tentative.
    const url = new URL('/login', req.url);
    url.searchParams.set('next', parsed.url);
    return NextResponse.redirect(url);
  }

  // Consomme le cookie AVANT l'appel downstream pour garantir l'idempotence
  // côté navigation (refresh = pas de double-bounce).
  try {
    const { magicLinkUrl } = await issueMagicLinkForApp({
      app: parsed.app,
      hubUserId: user.supabaseUserId ?? user.id,
      email: user.email,
    });
    return wipeCookies(NextResponse.redirect(magicLinkUrl));
  } catch (err) {
    if (err instanceof BounceError) {
      if (err.code === 'user_not_in_app') {
        const url = new URL('/dashboard', req.url);
        url.searchParams.set('app', parsed.app);
        url.searchParams.set('hint', 'signup');
        return wipeCookies(NextResponse.redirect(url));
      }
      console.error(
        JSON.stringify({
          tag: '[bounce][critical]',
          level: 'error',
          msg: 'complete: bounce failed',
          app: parsed.app,
          code: err.code,
          http_status: err.httpStatus,
          error_message: err.message,
          ts: new Date().toISOString(),
        })
      );
      const url = new URL('/auth/bounce/error', req.url);
      url.searchParams.set('app', parsed.app);
      url.searchParams.set('code', err.code);
      return wipeCookies(NextResponse.redirect(url));
    }
    console.error(
      JSON.stringify({
        tag: '[bounce][critical]',
        level: 'error',
        msg: 'complete: unexpected error',
        app: parsed.app,
        error: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      })
    );
    const url = new URL('/auth/bounce/error', req.url);
    url.searchParams.set('app', parsed.app);
    url.searchParams.set('code', 'unexpected');
    return wipeCookies(NextResponse.redirect(url));
  }
}
