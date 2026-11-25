/**
 * L'identité vérifiée devient un geste : essai, ajout d'adresse, liaison, ou session. Le même chemin pour l'OIDC et le SAML (VER-227). La session naît par
 * Auth.js, comme toutes les autres, et n'ouvre que cette organisation.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { auth, signIn } from '@/auth';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { ajouterParFournisseur } from '@/lib/adresses/federation';
import { NEXT_COOKIE_NAME_INSECURE, NEXT_COOKIE_NAME_SECURE } from '@/lib/auth/bounce-next';
import { getCurrentUser } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { roleAuHub } from '@/lib/delegation/interrupteur';
import { prisma } from '@/lib/prisma';
import { COOKIE_ACTIF } from '@/lib/tenants/actif';

import { seulementIci } from './borne';
import { resoudreIdentite, type Connecte } from './identite';
import { idpPret, type IdpPret } from './idp';
import { relierParPersonne } from './liaison';
import { COOKIE_PREMIERE, PREMIERE_S, scellerPremiere } from './premiere';
import { porteValable, retenirPorte } from './porte';
import type { Identite, Transaction } from './oidc';
import { emettreTicket, FOURNISSEUR_FEDERATION } from './ticket';

/** La personne déjà connectée par ses propres moyens, preuve récente, jamais une session d'emprunt ni fédérée : la seule qui relie un compte existant. */
async function connecte(): Promise<Connecte> {
  const session = await auth();
  if (!session?.user || isImpersonatedSession(session) || session.user.federe === true || !isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return null;
  const u = await getCurrentUser();
  return u?.email ? { userId: u.id, email: u.email } : null;
}

export type Sortie = { vers: (chemin: string) => NextResponse; refus: (code: string, detail?: string) => NextResponse };

/** Redirections du retour : la transaction de ce navigateur est détruite à chaque fois. */
export function sortieDe(base: URL, cookie: { nom: string; chemin: string }): Sortie {
  const vers = (chemin: string) => {
    const r = NextResponse.redirect(new URL(chemin, base), 303);
    r.headers.set('Cache-Control', 'no-store');
    r.cookies.set(cookie.nom, '', { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: cookie.chemin, maxAge: 0 });
    return r;
  };
  return {
    vers,
    refus: (code, detail) => {
      console.warn(JSON.stringify({ tag: '[federation][refus]', level: 'warn', code, detail: detail?.slice(0, 160) }));
      return vers(`/auth/federation?code=${code}`);
    },
  };
}

/** Le fournisseur d'une transaction : actif, ou celui que son propriétaire essaie. */
export const idpDe = (t: Transaction): Promise<IdpPret | null> => (t.essai ? idpPret(prisma, { id: t.idp }, process.env, true) : idpPret(prisma, { id: t.idp }));

export async function conclure(request: NextRequest, base: URL, i: IdpPret, t: Transaction, identite: Identite, { vers, refus }: Sortie): Promise<NextResponse> {
  if (t.essai) {
    // Le propriétaire qui l'a demandé, toujours propriétaire : rien n'est relié, l'identité reçue n'est pas gardée.
    const elle = await connecte();
    const u = elle?.userId === t.essai.userId ? await prisma.user.findUnique({ where: { id: elle.userId }, select: { id: true, supabaseUserId: true } }) : null;
    if (!u?.supabaseUserId || (await roleAuHub(prisma, i.tenantId, u.supabaseUserId)) !== 'owner') return refus('demande_expiree');
    await prisma.tenantIdp.update({ where: { id: i.id }, data: { essaiLe: new Date() } });
    await writeAuditLog(prisma, { action: 'federation.idp_essaye', actor: `user:${u.id}`, targetType: 'tenant', targetId: i.tenantId, payload: { protocole: i.protocole ?? 'oidc' } });
    return vers('/dashboard/organisation?avis=essai_reussi');
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
  if ('refus' in r) {
    if (r.refus !== 'non_relie') return refus(r.refus);
    // Identifiant inconnu, fournisseur sans adresse : elle prouve l'adresse que l'organisation attend (lib/federation/premiere.ts).
    const p = vers('/auth/premiere-entree');
    p.cookies.set(COOKIE_PREMIERE, scellerPremiere({ idp: i.id, sub: identite.sub }), { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: PREMIERE_S });
    return p;
  }
  return ouvrirSession(request, base, i, r, { vers, refus });
}

/** La session naît par Auth.js, n'ouvre que cette organisation, et ce navigateur retient sa porte. */
export async function ouvrirSession(request: NextRequest, base: URL, i: IdpPret, r: { userId: string; hubUserId: string; neuf: boolean }, { vers, refus }: Sortie): Promise<NextResponse> {
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
  const p = await prisma.tenantIdp.findUnique({ where: { id: i.id }, select: { alias: true } }).catch(() => null);
  const t = p?.alias ? null : await prisma.tenant.findFirst({ where: { id: i.tenantId }, select: { slug: true } }).catch(() => null);
  const porte = porteValable(p?.alias ?? t?.slug ?? undefined);
  if (porte) retenirPorte(res, porte, base.protocol === 'https:');
  return res;
}
