/**
 * POST /api/admin/ia/atelier { tenant_id, ouvert } : ouvre ou ferme l'abonnement (moteur claude-code-abonnement) pour
 * un tenant. Fermé par défaut ; la limite est la capacité de l'atelier (ATELIER_CAPACITE tenants ouverts), plus une
 * autorisation (Robert, 23/11). Fermer ne déconnecte pas le compte dans l'atelier : le chat refuse, c'est tout.
 * GET : les tenants ouverts et la capacité. Admin seulement, audit `admin.ia.atelier`. `hub ia atelier`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/admin/require-admin';
import { writeAuditLog } from '@/lib/admin/audit-log';
import { capaciteAtelier, ouvertDans } from '@/lib/ia/atelier';
import { prisma } from '@/lib/prisma';
import { fusionnerMetadata } from '@/lib/tenants/metadata-fusion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Corps = z.object({ tenant_id: z.string().uuid(), ouvert: z.boolean() });

async function tenantsOuverts(): Promise<string[]> {
  const lignes = await prisma.tenant.findMany({
    where: { deletedAt: null, metadata: { path: ['ia_atelier', 'ouvert'], equals: true } },
    select: { id: true, metadata: true },
  });
  return lignes.filter((l) => ouvertDans(l.metadata)).map((l) => l.id);
}

export async function GET(req: NextRequest) {
  const refus = await requireAdmin(req);
  if (refus) return refus;
  return NextResponse.json({ capacite: capaciteAtelier(), ouverts: await tenantsOuverts() });
}

export async function POST(req: NextRequest) {
  const refus = await requireAdmin(req);
  if (refus) return refus;
  const r = Corps.safeParse(await req.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  const t = await prisma.tenant.findUnique({ where: { id: r.data.tenant_id }, select: { id: true, deletedAt: true, metadata: true } });
  if (!t || t.deletedAt) return NextResponse.json({ error: 'tenant_inconnu' }, { status: 404 });

  const ouverts = await tenantsOuverts();
  if (r.data.ouvert && !ouverts.includes(t.id) && ouverts.length >= capaciteAtelier()) {
    return NextResponse.json({ error: 'capacite_atteinte', capacite: capaciteAtelier(), ouverts }, { status: 409 });
  }
  // La seule clé ia_atelier, fusionnée par la base (26/11).
  await fusionnerMetadata(prisma, t.id, { ia_atelier: { ouvert: r.data.ouvert, le: new Date().toISOString(), par: 'admin' } });
  await writeAuditLog(prisma, {
    action: 'admin.ia.atelier',
    actor: 'admin',
    targetType: 'tenant',
    targetId: t.id,
    payload: { ouvert: r.data.ouvert },
  });
  return NextResponse.json({ tenant_id: t.id, ouvert: r.data.ouvert, capacite: capaciteAtelier() });
}
