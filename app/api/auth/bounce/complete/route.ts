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
 *     - tout refus → `/auth/bounce/error?app=...&code=...`, qui l'explique, et une ligne
 *       `[bounce][refus]` (app, code, hub_user_id). Plus jamais de retour muet au tableau de bord.
 *
 * Pourquoi un Route Handler et pas un Server Component : Next.js 15 interdit
 * `cookies().set()`/`.delete()` dans un Server Component. On a besoin de
 * vider le cookie après usage (consommation atomique).
 */

import { NextRequest, NextResponse } from 'next/server';

import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { denyUnlessEmailProven } from '@/lib/auth/email-proof';
import {
  isRealNavigation,
  parseNext,
  verifyNextCookie,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
} from '@/lib/auth/bounce-next';
import { issueMagicLinkForApp, BounceError } from '@/lib/auth/bounce-apps';
import { journaliserRefus } from '@/lib/auth/bounce-refus';
import { isEmailProvenInDb } from '@/lib/auth/email-proof-provider';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Sans corps ni cookie consommé : le routeur Next retombe sur une navigation complète.
  if (!isRealNavigation(req)) {
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const deployEnv = process.env.DEPLOY_ENV;
  const secret = process.env.AUTH_SECRET;

  // Base URL publique : derrière Traefik, req.url vaut https://0.0.0.0:3000.
  // getHubBaseUrl force NEXT_PUBLIC_SITE_URL (cf lib/mail/oauth-cookies.ts).
  const baseUrl = getHubBaseUrl(req.url);

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
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', baseUrl)));
  }

  const next = verifyNextCookie(cookieValue, secret);
  if (!next) {
    // Pas de cookie ou expiré / signature invalide : pas de cible légitime.
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', baseUrl)));
  }

  const parsed = parseNext(next, deployEnv);
  if (!parsed) {
    // Cookie présent mais host plus dans la whitelist (cas pathologique :
    // deploy / env changed pendant le flow).
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', baseUrl)));
  }

  const user = await getCurrentUser();
  if (!user || !user.email) {
    // Pas de session : OAuth a échoué silencieusement. On garde le cookie
    // next pour relayer la prochaine tentative.
    const url = new URL('/login', baseUrl);
    url.searchParams.set('next', parsed.url);
    return NextResponse.redirect(url);
  }

  // Adresse non prouvée : aucun lien vers une app. Le lien de preuve part par mail
  // et le tableau de bord explique la suite.
  const denied = await denyUnlessEmailProven(user);
  if (denied) {
    journaliserRefus({ app: parsed.app, code: 'email_not_proven', hubUserId: user.supabaseUserId ?? null });
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', baseUrl)));
  }

  // Consomme le cookie AVANT l'appel downstream pour garantir l'idempotence
  // côté navigation (refresh = pas de double-bounce).
  try {
    const { magicLinkUrl } = await issueMagicLinkForApp({
      app: parsed.app,
      hubUserId: userUuid(user),
      email: user.email,
      emailProven: await isEmailProvenInDb(prisma, userUuid(user)),
      next: parsed.url,
    });
    return wipeCookies(NextResponse.redirect(magicLinkUrl));
  } catch (err) {
    const code = err instanceof BounceError ? err.code : 'unexpected';
    journaliserRefus({
      app: parsed.app,
      code,
      hubUserId: user.supabaseUserId ?? null,
      httpStatus: err instanceof BounceError ? err.httpStatus : undefined,
    });
    if (!(err instanceof BounceError)) {
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
    }
    const url = new URL('/auth/bounce/error', baseUrl);
    url.searchParams.set('app', parsed.app);
    url.searchParams.set('code', code);
    return wipeCookies(NextResponse.redirect(url));
  }
}
