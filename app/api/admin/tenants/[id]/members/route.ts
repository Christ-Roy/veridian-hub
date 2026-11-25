/** POST /api/admin/tenants/[id]/members { email | hub_user_id, role? } : pose un membre, en opérateur (VER-245). */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveActor } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { presenceDe, presenceIncomplete } from '@/lib/apps/presence';
import { suivreOrganisation } from '@/lib/organisations/emission';
import { prisma } from '@/lib/prisma';
import { rejoindre, ROLES } from '@/lib/tenants/membres';
import { pousserRole } from '@/lib/tenants/roles';
import { Compte, compteVise, IdTenant, refuser } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = Compte.and(z.object({ role: z.enum(ROLES).default('member') }));

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const hubUserId = await compteVise(c.data);
  if (!hubUserId) return NextResponse.json({ error: 'compte_introuvable' }, { status: 404 });
  try {
    const r = await rejoindre(prisma, { tenantId: id.data, hubUserId, role: c.data.role, origine: 'operateur', acteur: resolveActor(request.headers, null) });
    // Le rôle part aussitôt chez les apps qui le traduisent, relu. 207 : une app n'a pas suivi ; rejouer est sans effet de bord.
    const apps = await pousserRole(prisma, { tenantId: id.data, hubUserId });
    // L'organisation réglée au Hub emmène le membre dans les apps cochées (VER-252).
    const organisation = await suivreOrganisation(prisma, id.data);
    // « Créé » ne dit que le Hub : ce que chaque app voit vraiment se relit, et un manque se dit (Robert, 25/11).
    const presence = await presenceDe(prisma, id.data, hubUserId);
    const incomplet = apps.some((a) => a.etat === 'echec' || a.etat === 'refuse') || presenceIncomplete(presence);
    return NextResponse.json({ ...r, apps, presence, ...(organisation.length ? { organisation } : {}) }, { status: incomplet ? 207 : 200 });
  } catch (err) {
    return refuser(err);
  }
}
