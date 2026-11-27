/**
 * POST /api/admin/tenants/[id]/admins-plateforme { raison? } : pose les administrateurs de plateforme en ADMIN dans les espaces de l'organisation
 * (jamais propriétaire, jamais remis après un retrait du client). 200 rien en échec, 207 sinon. Contrat : CONTRAT-HUB §5.23.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { sessionAdmin } from '@/lib/admin/session-admin';
import { designationEnEchec, designerAdminsPlateforme } from '@/lib/apps/admins-plateforme';
import { PAR_CLE } from '@/lib/auth/emprunt-bornes';
import { prisma } from '@/lib/prisma';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Corps = z.strictObject({ raison: z.string().max(300).nullish() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => ({})));
  if (!id.success || !c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  // L'auteur : la personne connectée, sinon l'outil nommé par sa clé. Jamais une adresse.
  const s = request.headers.get('x-admin-secret') ? null : await sessionAdmin();
  const acteur = s?.ok ? s.hubUserId : PAR_CLE;
  const r = await designerAdminsPlateforme(prisma, id.data, { acteur, raison: c.data.raison });
  if (!r) return NextResponse.json({ error: 'tenant_introuvable' }, { status: 404 });
  await writeAuditLog(prisma, { action: 'admin.tenant.admins_plateforme', actor: resolveActor(request.headers, s?.ok ? s.email : null), targetType: 'tenant', targetId: id.data, payload: { designations: r } });
  return NextResponse.json({ designations: r }, { status: designationEnEchec(r) ? 207 : 200 });
}
