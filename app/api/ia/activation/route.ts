/** « Mon IA » : l'interrupteur du chat pour (app, tenant), coupé par défaut (docs/MON-IA.md). */
import { NextResponse, type NextRequest } from 'next/server';

import { writeAuditLog } from '@/lib/admin/audit-log';
import { activer, estAppChat } from '@/lib/ia/branchements';
import { contexteUtilisateur, espaceDe } from '@/lib/ia/contexte';
import { refusSiCroisee } from '@/lib/ia/requete';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const croisee = refusSiCroisee(req);
  if (croisee) return croisee;
  const c = await contexteUtilisateur();
  if (c instanceof NextResponse) return c;
  const corps = (await req.json().catch(() => null)) as { app?: unknown; tenantId?: unknown; enabled?: unknown } | null;
  if (!corps || !estAppChat(corps.app) || typeof corps.enabled !== 'boolean') {
    return NextResponse.json({ error: 'requete_invalide' }, { status: 400 });
  }
  const espace = await espaceDe(c.hubUserId, corps.tenantId, c.qui.preuve);
  if (!espace) return NextResponse.json({ error: 'espace_inconnu' }, { status: 404 });
  await activer(prisma, { hubUserId: c.hubUserId, app: corps.app, tenantId: espace.id }, corps.enabled);
  await writeAuditLog(prisma, {
    action: corps.enabled ? 'ia.activation' : 'ia.desactivation',
    actor: c.email,
    targetType: 'ia_activation',
    targetId: c.hubUserId,
    payload: { app: corps.app, tenant_id: espace.id },
  });
  return NextResponse.json({ app: corps.app, tenantId: espace.id, enabled: corps.enabled });
}
