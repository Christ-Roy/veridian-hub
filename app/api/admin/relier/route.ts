/**
 * POST /api/admin/relier : relie les espaces existants d'une app à leur tenant Hub (claim `tenant_id`
 * du JWT MCP), par la route `link-hub` de l'app : lien seul, jamais écrasé, aucune écriture au Hub.
 * Admin seulement. Corps : { app: 'prospection'|'analytics', tenant_id?: string, appliquer?: boolean }
 * (défaut : simulation). Raisons rendues telles que l'app les donne (relie, deja_relie, lien_different…).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAdmin } from '@/lib/admin/require-admin';
import { lierAuHub, type LienHub } from '@/lib/apps/lier-hub';
import { tenantHasApp } from '@/lib/plans/app-plan';
import { createProspectionClientFromEnv } from '@/lib/prospection/client';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

const Corps = z.object({
  app: z.enum(['prospection', 'analytics']),
  tenant_id: z.string().uuid().optional(),
  appliquer: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;
  const r = Corps.safeParse(await request.json().catch(() => ({})));
  if (!r.success) return NextResponse.json({ error: 'invalid', details: r.error.issues }, { status: 400 });
  const { app, appliquer } = r.data;

  let lier: (t: { id: string; userId: string }) => Promise<LienHub>;
  if (app === 'prospection') {
    const client = createProspectionClientFromEnv();
    if (!client) return NextResponse.json({ error: 'prospection_not_configured' }, { status: 503 });
    lier = async (t) => {
      const l = await client.linkHub({ hubUserId: t.userId, hubTenantId: t.id });
      return { linked: l.linked, raison: l.raison ?? (l.linked ? 'relie' : 'inconnue') };
    };
  } else {
    lier = (t) => lierAuHub('analytics', { hubUserId: t.userId, hubTenantId: t.id });
  }

  const candidats = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      ...(app === 'prospection' ? { prospectionProvisionedAt: { not: null } } : {}),
      ...(r.data.tenant_id ? { id: r.data.tenant_id } : {}),
    },
    select: { id: true, userId: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
  const tenants = app === 'analytics' ? candidats.filter((t) => tenantHasApp(t.metadata, 'analytics')) : candidats;

  const resultats: { tenant_id: string; issue: string }[] = [];
  for (const t of tenants) {
    if (!appliquer) {
      resultats.push({ tenant_id: t.id, issue: 'a_relier' });
      continue;
    }
    try {
      const l = await lier(t);
      resultats.push({ tenant_id: t.id, issue: l.linked ? l.raison : `non_relie: ${l.raison}` });
    } catch (err) {
      resultats.push({ tenant_id: t.id, issue: `echec: ${err instanceof Error ? err.message.slice(0, 120) : 'inconnu'}` });
    }
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'admin.app.relier',
        actor: 'admin',
        targetType: 'app',
        targetId: app,
        payload: { appliquer, total: tenants.length, relies: resultats.filter((x) => !x.issue.startsWith('non_relie') && !x.issue.startsWith('echec') && x.issue !== 'a_relier').length },
      },
    })
    .catch(() => {});
  const echecs = resultats.filter((x) => x.issue.startsWith('non_relie') || x.issue.startsWith('echec')).length;
  return NextResponse.json({ app, appliquer, total: tenants.length, echecs, resultats }, { status: echecs ? 207 : 200 });
}
