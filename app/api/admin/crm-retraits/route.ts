/**
 * Retraits du CRM retenus par le fusible (lib/apps/retrait-crm.ts, 23/11). Admin seulement.
 *   GET  : ceux qui attendent encore { retraits: [{ hub_user_id, depuis, raison, espaces }], fusible }
 *   POST { hub_user_id } : rejoue un retrait, seulement si le fusible est levé (CRM_RETRAIT_FUSIBLE=0)
 * Aucune adresse dans la réponse (les logs Actions sont publics).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { requireAdmin } from '@/lib/admin/require-admin';
import { fusibleCrmActif } from '@/lib/apps/retrait-crm';
import { pushUserToApps } from '@/lib/identity/push-user';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const Corps = z.object({ hub_user_id: z.string().uuid() });

async function enAttente() {
  const lignes = await prisma.auditLog.findMany({
    where: { action: { in: ['crm.retrait.attente', 'crm.retrait.rejoue'] } },
    orderBy: { createdAt: 'asc' },
    select: { action: true, targetId: true, payload: true, createdAt: true },
  });
  const parCompte = new Map<string, { hub_user_id: string; depuis: string; raison: unknown; espaces: unknown }>();
  for (const l of lignes) {
    if (!l.targetId) continue;
    const p = (l.payload ?? {}) as { raison?: unknown; espaces?: unknown };
    if (l.action === 'crm.retrait.attente') parCompte.set(l.targetId, { hub_user_id: l.targetId, depuis: l.createdAt.toISOString(), raison: p.raison, espaces: p.espaces });
    else parCompte.delete(l.targetId);
  }
  return Array.from(parCompte.values());
}

export async function GET(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  return NextResponse.json({ retraits: await enAttente(), fusible: fusibleCrmActif() });
}

export async function POST(request: NextRequest) {
  const refus = await requireAdmin(request);
  if (refus) return refus;
  const r = Corps.safeParse(await request.json().catch(() => null));
  if (!r.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  if (fusibleCrmActif()) return NextResponse.json({ error: 'fusible_actif' }, { status: 409 });
  if (!(await enAttente()).some((x) => x.hub_user_id === r.data.hub_user_id)) {
    return NextResponse.json({ error: 'pas_en_attente' }, { status: 404 });
  }
  const { crm } = await pushUserToApps({ hubUserId: r.data.hub_user_id, deleted: true }, { apps: ['crm'] });
  if (crm !== 'ok' && crm !== 'not_in_app') return NextResponse.json({ error: 'echec', resultat: crm ?? null }, { status: 502 });
  await writeAuditLog(prisma, { action: 'crm.retrait.rejoue', actor: 'admin', targetType: 'user', targetId: r.data.hub_user_id, payload: { resultat: crm } });
  return NextResponse.json({ rejoue: true, resultat: crm });
}
