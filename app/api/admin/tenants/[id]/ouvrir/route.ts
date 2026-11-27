/** POST /api/admin/tenants/[id]/ouvrir { apps } : ouvre l'organisation dans ces apps et relit chacune ; Mail ouvert, les administrateurs de plateforme y sont posés admin (§5.23). 200 complet, 207 en partie ou non abouti. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveActor, writeAuditLog } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { PAR_CLE } from '@/lib/auth/emprunt-bornes';
import { ouvrirApps } from '@/lib/apps/ouvrir';
import { prisma } from '@/lib/prisma';
import { SYNC_APPS, type SyncApp } from '@/lib/sync/types';
import { IdTenant } from '@/lib/tenants/membres-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const Corps = z.strictObject({ apps: z.array(z.enum(SYNC_APPS as unknown as [SyncApp, ...SyncApp[]])).min(1).max(SYNC_APPS.length) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;
  const id = IdTenant.safeParse((await params).id);
  const c = Corps.safeParse(await request.json().catch(() => null));
  if (!id.success || !c.success) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  const acteur = resolveActor(request.headers, null);
  // Auteur des désignations d'admin chez les apps : la personne connectée, sinon l'outil nommé par sa clé. Jamais une adresse.
  const s = garde.admin;
  const r = await ouvrirApps(prisma, id.data, Array.from(new Set(c.data.apps)), { acteur, auteur: s ? s.hubUserId : PAR_CLE });
  if (!r) return NextResponse.json({ error: 'tenant_introuvable' }, { status: 404 });
  await writeAuditLog(prisma, { action: 'admin.tenant.ouvrir', actor: acteur, targetType: 'tenant', targetId: id.data, payload: { verdict: r.verdict, apps: r.apps.map((a) => ({ app: a.app, etat: a.etat })), admins: r.admins.map((a) => ({ app: a.app, etat: a.etat })) } });
  return NextResponse.json(r, { status: r.verdict === 'complet' ? 200 : 207 });
}
