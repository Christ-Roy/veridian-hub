/**
 * POST /api/admin/prospection/relier : relie chaque tenant Prospection existant à son tenant Hub
 * (`hub_tenant_id`, claim `tenant_id` du JWT MCP) par `POST /api/tenants/link-hub`.
 *
 * Pas de rejeu du provisionnement : chez Prospection il remet le rôle du propriétaire à admin et
 * recrée l'espace `default` s'il a été renommé (09/11). link-hub ne pose que le lien, s'il est vide.
 * Aucune écriture au Hub. Admin seulement. Corps : { tenant_id?: string, appliquer?: boolean }
 * (défaut : simulation).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/admin/require-admin';
import { createProspectionClientFromEnv } from '@/lib/prospection/client';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const Corps = z.object({ tenant_id: z.string().uuid().optional(), appliquer: z.boolean().default(false) });

export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;
  const r = Corps.safeParse(await request.json().catch(() => ({})));
  if (!r.success) return NextResponse.json({ error: 'invalid', details: r.error.issues }, { status: 400 });
  const client = createProspectionClientFromEnv();
  if (!client) return NextResponse.json({ error: 'prospection_not_configured' }, { status: 503 });

  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null, prospectionProvisionedAt: { not: null }, ...(r.data.tenant_id ? { id: r.data.tenant_id } : {}) },
    select: { id: true, userId: true },
    orderBy: { createdAt: 'asc' },
  });
  const users = await prisma.user.findMany({
    where: { supabaseUserId: { in: tenants.map((t) => t.userId) } },
    select: { supabaseUserId: true },
  });

  const resultats: { tenant_id: string; issue: string }[] = [];
  for (const t of tenants) {
    const u = users.find((x) => x.supabaseUserId === t.userId);
    if (!u) {
      resultats.push({ tenant_id: t.id, issue: 'proprietaire_absent' });
      continue;
    }
    if (!r.data.appliquer) {
      resultats.push({ tenant_id: t.id, issue: 'a_relier' });
      continue;
    }
    try {
      const lien = await client.linkHub({ hubUserId: t.userId, hubTenantId: t.id });
      resultats.push({ tenant_id: t.id, issue: lien.linked ? 'relie' : `non_relie: ${lien.raison ?? 'inconnue'}` });
    } catch (err) {
      resultats.push({ tenant_id: t.id, issue: `echec: ${err instanceof Error ? err.message.slice(0, 120) : 'inconnu'}` });
    }
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'admin.prospection.relier',
        actor: 'admin',
        targetType: 'tenant',
        targetId: r.data.tenant_id ?? null,
        payload: { appliquer: r.data.appliquer, total: tenants.length, relies: resultats.filter((x) => x.issue === 'relie').length },
      },
    })
    .catch(() => {});
  const echecs = resultats.filter((x) => x.issue !== 'relie' && x.issue !== 'a_relier').length;
  return NextResponse.json({ appliquer: r.data.appliquer, total: tenants.length, echecs, resultats }, { status: echecs ? 207 : 200 });
}
