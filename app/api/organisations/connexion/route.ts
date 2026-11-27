/**
 * POST (formulaire de /dashboard/organisation) : le propriétaire rend sa connexion obligatoire ou libre, ou retire un accès gardé (VER-261). Preuve récente,
 * jamais une session d'emprunt ni fédérée, et jamais une session que cette organisation n'ouvre pas.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { getCurrentUser, userUuid } from '@/lib/auth/get-user';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { RateLimiter } from '@/lib/auth/rate-limit';
import { isAuthRecent, PREUVE_COMPTE_S } from '@/lib/auth/recent-auth';
import { roleAuHub } from '@/lib/delegation/interrupteur';
import { leverExemption, reglerConnexion } from '@/lib/federation/connexion';
import { fermeeIci } from '@/lib/federation/session';
import { getHubBaseUrl } from '@/lib/mail/oauth-cookies';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const debit = new RateLimiter({ capacity: 20, windowMs: 60 * 60_000, name: 'connexion-organisation' });

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
  const moi = userUuid(user);
  if ((await roleAuHub(prisma, id.data, moi)) !== 'owner') return vers('proprietaire_seul');
  if (await fermeeIci(moi, id.data)) return vers('organisation_fournisseur');
  if (!debit.enforce(user.id).ok) return vers('trop_de_gestes');
  const acteur = `user:${user.id}`;
  const geste = f.get('geste');
  if (geste === 'obligatoire' || geste === 'libre') {
    const r = await reglerConnexion(prisma, { tenantId: id.data, obligatoire: geste === 'obligatoire', acteur, proprietaire: moi });
    return vers('refus' in r ? r.refus : `connexion_${geste}`);
  }
  if (geste === 'retirer_acces') {
    const qui = z.string().uuid().safeParse(f.get('hub_user_id'));
    if (!qui.success) return vers('refus');
    const r = await leverExemption(prisma, { tenantId: id.data, hubUserId: qui.data, acteur });
    return vers('refus' in r ? r.refus : 'acces_retire');
  }
  return vers('refus');
}
