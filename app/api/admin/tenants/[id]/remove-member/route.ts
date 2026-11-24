/** POST /api/admin/tenants/[id]/remove-member { email | hub_user_id } (CONTRAT-HUB §5.19.1) : coupe au Hub, puis chez chaque app, relue. */
import { NextRequest, NextResponse } from 'next/server';

import { resolveActor } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { prisma } from '@/lib/prisma';
import { retirer } from '@/lib/tenants/membres';
import { Compte, compteVise, IdTenant, refuser, rendre } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = Compte.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const hubUserId = await compteVise(c.data);
  if (!hubUserId) return NextResponse.json({ error: 'compte_introuvable' }, { status: 404 });
  try {
    return rendre(await retirer(prisma, { tenantId: id.data, hubUserId, acteur: resolveActor(request.headers, null) }));
  } catch (err) {
    return refuser(err);
  }
}
