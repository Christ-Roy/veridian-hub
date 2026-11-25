/**
 * GET : le retour du fournisseur d'une organisation. La transaction est dans le cookie scellé de CE navigateur, détruite à chaque retour ; tout ce que
 * le fournisseur affirme est vérifié avant d'être lu. La session naît ensuite par Auth.js, comme toutes les autres.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { auth, signIn } from '@/auth';
import { ajouterParFournisseur } from '@/lib/adresses/federation';
import { NEXT_COOKIE_NAME_INSECURE, NEXT_COOKIE_NAME_SECURE } from '@/lib/auth/bounce-next';
import { getCurrentUser } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { seulementIci } from '@/lib/federation/borne';
import { resoudreIdentite, type Connecte } from '@/lib/federation/identite';
import { idpPret } from '@/lib/federation/idp';
import { relierParPersonne } from '@/lib/federation/liaison';
import { CHEMIN_RETOUR, COOKIE_FEDERATION, ouvrir, terminer } from '@/lib/federation/oidc';
import { emettreTicket, FOURNISSEUR_FEDERATION } from '@/lib/federation/ticket';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { COOKIE_ACTIF } from '@/lib/tenants/actif';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** La personne déjà connectée par ses propres moyens, preuve récente, jamais une session d'emprunt ni fédérée : la seule qui relie un compte existant. */
async function connecte(): Promise<Connecte> {
  const session = await auth();
  if (!session?.user || isImpersonatedSession(session) || session.user.federe === true || !isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return null;
  const u = await getCurrentUser();
  return u?.email ? { userId: u.id, email: u.email } : null;
}

export async function GET(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (chemin: string) => {
    const r = NextResponse.redirect(new URL(chemin, base), 303);
    r.headers.set('Cache-Control', 'no-store');
    r.cookies.set(COOKIE_FEDERATION, '', { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: CHEMIN_RETOUR, maxAge: 0 });
    return r;
  };
  const refus = (code: string, detail?: string) => {
    console.warn(JSON.stringify({ tag: '[federation][refus]', level: 'warn', code, detail: detail?.slice(0, 160) }));
    return vers(`/auth/federation?code=${code}`);
  };
  const t = ouvrir(request.cookies.get(COOKIE_FEDERATION)?.value);
  if (!t) return refus('demande_expiree');
  const i = await idpPret(prisma, { id: t.idp });
  if (!i) return refus('organisation_indisponible');
  let identite;
  try {
    identite = await terminer(i, t, new URL(`${CHEMIN_RETOUR}${new URL(request.url).search}`, base));
  } catch (err) {
    return refus('reponse_refusee', err instanceof Error ? `${err.name} ${(err as { code?: string }).code ?? ''}` : undefined);
  }
  if (t.ajout) {
    // La personne qui l'a demandé, toujours connectée dans CE navigateur ; sinon le jeton d'un autre onglet prouverait une adresse à sa place.
    const elle = await connecte();
    const u = elle?.userId === t.ajout.userId ? await prisma.user.findUnique({ where: { id: elle.userId }, select: { id: true, email: true, emailVerified: true, supabaseUserId: true } }) : null;
    if (!u) return refus('demande_expiree');
    const a = await ajouterParFournisseur(prisma, i, identite, u, t.ajout.email);
    return 'refus' in a ? refus(a.refus) : vers('/dashboard/settings?adresse=ajoutee');
  }
  if (t.relier) {
    const elle = await connecte();
    const u = elle?.userId === t.relier.userId ? await prisma.user.findUnique({ where: { id: elle.userId }, select: { id: true, email: true, emailVerified: true, supabaseUserId: true } }) : null;
    if (!u) return refus('demande_expiree');
    const l = await relierParPersonne(prisma, i, identite, u);
    return 'refus' in l ? refus(l.refus) : vers('/dashboard/settings?federation=reliee');
  }
  const r = await resoudreIdentite(prisma, i, identite, await connecte());
  if ('refus' in r) return refus(r.refus);
  const suite = request.cookies.has(NEXT_COOKIE_NAME_SECURE) || request.cookies.has(NEXT_COOKIE_NAME_INSECURE) ? '/api/auth/bounce/complete' : '/dashboard';
  // Elle n'ouvre que cette organisation : quelqu'un d'ailleurs aussi entre par sa propre connexion (lib/federation/borne.ts).
  if (!(await seulementIci(prisma, r.hubUserId, i.tenantId))) return refus('autre_organisation');
  // Auth.js pose la session, ou renvoie vers la 2FA : son verdict fait foi.
  const ticket = await emettreTicket(prisma, r.userId, i.tenantId);
  const issue: unknown = await signIn(FOURNISSEUR_FEDERATION, { ticket, redirect: false, redirectTo: suite });
  const cible = typeof issue === 'string' ? new URL(issue, base) : new URL(suite, base);
  if (cible.origin !== base.origin || cible.searchParams.has('error')) return refus('session_refusee');
  console.log(JSON.stringify({ tag: '[federation][reussi]', level: 'info', hub_user_id: r.hubUserId, tenant_id: i.tenantId, neuf: r.neuf }));
  const res = vers(`${cible.pathname}${cible.search}`);
  res.cookies.set(COOKIE_ACTIF, i.tenantId, { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: 365 * 24 * 3600 });
  return res;
}
