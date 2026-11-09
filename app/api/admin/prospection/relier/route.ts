/**
 * POST /api/admin/prospection/relier : relie chaque tenant Prospection existant à son tenant Hub
 * (`hub_tenant_id`, claim `tenant_id` du JWT MCP) par un rejeu idempotent du provisionnement.
 *
 * Borné au lien : le plan envoyé est celui du tenant (aucun reset), aucun crédit, la clé d'API reste
 * (Prospection ne la régénère pas au rejeu). Prospection régénère son jeton de connexion directe :
 * sa nouvelle valeur est recopiée au Hub, sinon la carte du tableau de bord pointerait sur l'ancien.
 * Admin seulement. Corps : { tenant_id?: string, appliquer?: boolean } (défaut : simulation).
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
    select: { id: true, userId: true, name: true, prospectionPlan: true },
    orderBy: { createdAt: 'asc' },
  });
  const users = await prisma.user.findMany({
    where: { supabaseUserId: { in: tenants.map((t) => t.userId) } },
    select: { supabaseUserId: true, email: true, emailVerified: true },
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
      const data = await client.provisionTenant({
        email: u.email,
        name: t.name,
        userId: t.userId,
        plan: t.prospectionPlan ?? 'freemium',
        emailProven: Boolean(u.emailVerified),
        hubTenantId: t.id,
      });
      const jeton = data.login_url?.split('t=')[1] ?? null;
      if (jeton) {
        await prisma.tenant.update({
          where: { id: t.id },
          data: { prospectionLoginToken: jeton, prospectionLoginTokenCreatedAt: new Date(), prospectionLoginTokenUsed: false },
        });
      }
      resultats.push({ tenant_id: t.id, issue: 'relie' });
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
  const echecs = resultats.filter((x) => x.issue.startsWith('echec') || x.issue === 'proprietaire_absent').length;
  return NextResponse.json({ appliquer: r.data.appliquer, total: tenants.length, echecs, resultats }, { status: echecs ? 207 : 200 });
}
