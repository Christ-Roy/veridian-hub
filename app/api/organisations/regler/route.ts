/** POST (formulaire de /dashboard/organisation) : le propriétaire ou un admin règle son organisation. Rien n'est reçu qu'il ne puisse régler. */
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { fermeeIci } from '@/lib/federation/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { roleAuHub } from '@/lib/delegation/interrupteur';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { LOGO_MAX_OCTETS } from '@/lib/organisations/logo';
import { Reglage, reglerOrganisation } from '@/lib/organisations/reglage';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const base = getHubBaseUrl(request.url);
  const vers = (avis: string) => NextResponse.redirect(new URL(`/dashboard/organisation?avis=${avis}`, base), 303);
  if (request.headers.get('origin') !== base.origin) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  if (Number(request.headers.get('content-length') ?? 0) > LOGO_MAX_OCTETS + 20_000) return vers('trop_gros');
  const session = await auth();
  const user = await getCurrentUser();
  if (!user || !session) return NextResponse.redirect(new URL('/login?callbackUrl=/dashboard/organisation', base), 303);
  if (isImpersonatedSession(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const f = await request.formData().catch(() => null);
  const id = IdTenant.safeParse(f?.get('tenant'));
  if (!f || !id.success) return vers('refus');
  const role = await roleAuHub(prisma, id.data, userUuid(user));
  if (role !== 'owner' && role !== 'admin') return vers('role_insuffisant');
  if (await fermeeIci(userUuid(user), id.data)) return vers('organisation_fournisseur');
  const champ = (n: string) => { const v = String(f.get(n) ?? '').trim(); return v === '' ? null : v; };
  // Les modules et réglages d'app restent à l'opérateur : cet écran ne les reçoit pas.
  const c = Reglage.safeParse({ type: champ('type') ?? undefined, nom_affiche: champ('nom_affiche'), couleur_primaire: champ('couleur_primaire'), couleur_accent: champ('couleur_accent') });
  if (!c.success) return vers('refus');
  const fichier = f.get('logo');
  const logo = fichier instanceof File && fichier.size > 0 ? Buffer.from(await fichier.arrayBuffer()) : f.get('retirer_logo') === '1' ? null : undefined;
  const r = await reglerOrganisation(prisma, { tenantId: id.data, reglage: c.data, logo, acteur: `user:${userUuid(user)}` });
  if ('refus' in r) return vers(r.refus);
  return vers(r.emissions.every((e) => e.etat === 'applique') && r.retraits.every((x) => x.etat === 'retire' || x.etat === 'absent') ? 'enregistre' : 'partiel');
}
