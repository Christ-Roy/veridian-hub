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
 *       `[bounce][refus]` (app, code, hub_user_id) ; un succès laisse `[bounce][reussi]`, mêmes champs. Plus jamais de retour muet au tableau de bord.
 *
 * Pourquoi un Route Handler et pas un Server Component : Next.js 15 interdit
 * `cookies().set()`/`.delete()` dans un Server Component. On a besoin de
 * vider le cookie après usage (consommation atomique).
 */

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
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
import { COOKIE_ACTIF, organisationActive } from '@/lib/tenants/actif';
import { journaliserRefus, journaliserReussite } from '@/lib/auth/bounce-refus';
import { ensureAcademyWorkspace } from '@/lib/academy/provision';
import { ensureCrmWorkspace } from '@/lib/crm/provision';
import { getEnabledGatedApps } from '@/lib/tenant-apps';
import { isEmailProvenInDb } from '@/lib/auth/email-proof-provider';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { empruntSigne, suiteEmprunt } from '@/lib/emprunt/journal';
import { emettrePoignees } from '@/lib/delegation/poignee';
import { prisma } from '@/lib/prisma';
import type { SyncApp } from '@/lib/sync/types';
import { membreSeul } from '@/lib/tenants/membre-seul';
import { consommerPreinscriptions } from '@/lib/tenants/preinscription';
import { APPS_A_ROLE, organisationsPourRebond } from '@/lib/tenants/roles';

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

  // Pré-inscrit par une organisation : il la rejoint maintenant, et l'app le connaît avant qu'on l'y envoie. Un échec n'empêche pas d'entrer.
  const session = await auth();
  // Une session fédérée ne fait rejoindre aucune autre organisation : elle n'ouvre que la sienne.
  // Emprunt (VER-263) : on entre comme le client, on ne fait rien en son nom. Ni poignée de délégation, ni rôle porté, ni espace créé ; l'app sait qui est là.
  const enEmprunt = isImpersonatedSession(session);
  const emprunt = empruntSigne(session?.user);
  if (enEmprunt && !emprunt) {
    journaliserRefus({ app: parsed.app, code: 'unexpected', hubUserId: user.supabaseUserId ?? null });
    return wipeCookies(NextResponse.redirect(new URL('/dashboard', baseUrl)));
  }
  const tracer = (resultat: string, journalise: boolean | null) =>
    emprunt ? suiteEmprunt(prisma, { action: 'app', empruntId: emprunt.id, par: emprunt.par, userId: user.id, detail: { app: parsed.app, resultat, app_journalise: journalise } }) : Promise.resolve();
  const jointes = user.supabaseUserId && !enEmprunt && session?.user?.federe !== true
    ? await consommerPreinscriptions(prisma, user.supabaseUserId).catch((err): string[] => { console.error('[preinscription]', err instanceof Error ? err.message.slice(0, 160) : 'erreur'); return []; })
    : [];

  // Consomme le cookie AVANT l'appel downstream pour garantir l'idempotence
  // côté navigation (refresh = pas de double-bounce).
  try {
    const demande = {
      app: parsed.app,
      hubUserId: userUuid(user),
      email: user.email,
      emailProven: await isEmailProvenInDb(prisma, userUuid(user)),
      next: parsed.url,
      // Seulement aux apps qui le traduisent ; une lecture ratée n'empêche jamais d'entrer (l'app ne change alors rien).
      delegations: enEmprunt ? [] : await emettrePoignees(prisma, { hubUserId: userUuid(user), app: parsed.app }).catch(() => []),
      // Il vient de la rejoindre : il y arrive, même s'il a déjà son propre espace.
      hubTenantId: jointes[0] ?? await organisationActive(prisma, userUuid(user), req.cookies.get(COOKIE_ACTIF)?.value).catch(() => null),
      organisations: !enEmprunt && APPS_A_ROLE.includes(parsed.app as SyncApp) ? await organisationsPourRebond(prisma, userUuid(user)).catch(() => []) : [],
      emprunt,
    };
    // Academy est réservée : sans activation au Hub, aucun lien, même si l'app connaît encore le compte
    // (activation retirée). Le refus passe par la page d'erreur, jamais muet.
    const academyActivee =
      parsed.app === 'academy' && (await getEnabledGatedApps(prisma, userUuid(user))).has('academy');
    if (parsed.app === 'academy' && !academyActivee) {
      throw new BounceError('user_not_in_app', 'academy: compte non activé au Hub');
    }
    let magicLinkUrl: string;
    let empruntJournalise: boolean | undefined;
    let code: 'ok' | 'premiere_ouverture' = 'ok';
    try {
      ({ magicLinkUrl, empruntJournalise } = await issueMagicLinkForApp(demande));
    } catch (err) {
      // Le CRM est ouvert à tout compte prouvé, Academy à tout compte activé : à la première ouverture,
      // le Hub crée l'espace puis reprend.
      const premiere = err instanceof BounceError && err.code === 'user_not_in_app';
      if (!premiere || enEmprunt || (parsed.app !== 'crm' && parsed.app !== 'academy')) throw err;
      // Un salarié n'a pas d'espace à lui : pas ouvert à son organisation, c'est refusé et dit, jamais un espace vide créé à sa place.
      if (await membreSeul(prisma, userUuid(user))) throw err;
      const qui = { hubUserId: userUuid(user), email: user.email, name: user.name };
      const espace =
        parsed.app === 'crm'
          ? await ensureCrmWorkspace(prisma, qui, { actorEmail: 'premiere-ouverture' })
          : await ensureAcademyWorkspace(prisma, qui, { actorEmail: 'premiere-ouverture' });
      if (!espace.ok) throw err;
      ({ magicLinkUrl } = await issueMagicLinkForApp(demande));
      code = 'premiere_ouverture';
    }
    journaliserReussite({ app: parsed.app, code, hubUserId: demande.hubUserId });
    await tracer('entre', empruntJournalise ?? false);
    return wipeCookies(NextResponse.redirect(magicLinkUrl));
  } catch (err) {
    const code = err instanceof BounceError ? err.code : 'unexpected';
    await tracer(code, null);
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
