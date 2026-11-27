/**
 * POST (formulaire de /dashboard/organisation) : le propriétaire pose LUI-MÊME le fournisseur de connexion de son organisation (VER-227). Il n'affirme
 * aucune adresse, ne crée aucun compte, et ne s'ouvre qu'après un essai réussi par lui. Preuve récente, jamais une session d'emprunt ni fédérée.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { roleAuHub } from '@/lib/delegation/interrupteur';
import { partir } from '@/lib/federation/depart';
import { idpEssai, poserIdp, ReglageIdp, ReglageSaml, reglerIdpLibre } from '@/lib/federation/idp';
import { fermeeIci } from '@/lib/federation/session';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 20, windowMs: 60 * 60_000, name: 'federation-libre' });
const AVIS = { activer: 'fournisseur_actif', couper: 'fournisseur_coupe', retirer: 'fournisseur_retire' } as const;

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (avis: string) => NextResponse.redirect(new URL(`/dashboard/organisation?avis=${avis}`, base), 303);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  const session = await auth();
  const user = await getCurrentUser();
  if (!user || !session?.user) return NextResponse.redirect(new URL('/login?callbackUrl=/dashboard/organisation', base), 303);
  if (isImpersonatedSession(session) || session.user.federe === true) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!isAuthRecent(session.user.authAt, PREUVE_COMPTE_S)) return NextResponse.redirect(new URL('/login?reauth=1&callbackUrl=/dashboard/organisation', base), 303);
  const f = await request.formData().catch(() => null);
  const id = IdTenant.safeParse(f?.get('tenant'));
  if (!f || !id.success) return vers('refus');
  if ((await roleAuHub(prisma, id.data, userUuid(user))) !== 'owner') return vers('proprietaire_seul');
  if (await fermeeIci(userUuid(user), id.data)) return vers('organisation_fournisseur');
  if (!(await debit.enforce(user.id)).ok) return vers('trop_de_gestes');

  const acteur = `user:${user.id}`;
  const champ = (n: string) => String(f.get(n) ?? '').trim();
  const geste = champ('geste');
  if (geste === 'activer' || geste === 'couper' || geste === 'retirer') {
    const r = await reglerIdpLibre(prisma, id.data, geste);
    if ('refus' in r) return vers(r.refus);
    await writeAuditLog(prisma, { action: `federation.idp_${geste}`, actor: acteur, targetType: 'tenant', targetId: id.data });
    return vers(AVIS[geste]);
  }
  if (geste === 'essayer') {
    const i = await idpEssai(prisma, id.data);
    if (!i) return vers('absent');
    try {
      const d = await partir(i, base, { essai: { userId: user.id } });
      const r = NextResponse.redirect(d.url, 303);
      r.headers.set('Cache-Control', 'no-store');
      d.poser(r);
      return r;
    } catch (err) {
      console.error(JSON.stringify({ tag: '[federation]', level: 'error', msg: 'essai : fournisseur injoignable', idp: i.id, error: err instanceof Error ? err.message.slice(0, 160) : 'erreur' }));
      return vers('fournisseur_injoignable');
    }
  }
  if (geste !== 'poser') return vers('refus');
  const c = champ('protocole') === 'saml'
    ? ReglageSaml.safeParse({ protocole: 'saml', issuer: champ('issuer'), sso_url: champ('sso_url'), certificat: champ('certificat') })
    : ReglageIdp.safeParse({ issuer: champ('issuer'), client_id: champ('client_id'), client_secret: champ('client_secret'), domaines: [] });
  if (!c.success) return vers('fournisseur_incomplet');
  const r = await poserIdp(prisma, { tenantId: id.data, reglage: c.data, acteur, libreService: true });
  if ('refus' in r) return vers(r.refus);
  await writeAuditLog(prisma, { action: 'federation.idp_pose', actor: acteur, targetType: 'tenant', targetId: id.data, payload: { issuer: c.data.issuer, protocole: 'protocole' in c.data ? 'saml' : 'oidc', libre_service: true } });
  return vers('fournisseur_pose');
}
