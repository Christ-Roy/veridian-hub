import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  buildNotifuseClient,
  notifuseErrorResponse,
  resolveNotifuseTenant,
} from '@/lib/notifuse/admin-helpers';
import { isNotifusePlan, NOTIFUSE_PLANS } from '@/lib/notifuse/types';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PlanSource =
  | 'stripe'
  | 'manual'
  | 'lifetime_site_vitrine'
  | 'lifetime_partner'
  | 'internal';

const VALID_SOURCES: PlanSource[] = [
  'stripe',
  'manual',
  'lifetime_site_vitrine',
  'lifetime_partner',
  'internal',
];

interface RequestBody {
  tenantId?: string;
  plan?: string;
  reason?: string;
  /**
   * Source du changement de plan. Utilisé pour empêcher Stripe webhooks de
   * downgrade un tenant `lifetime_*` ou `internal`. Si absent, défaut `manual`.
   */
  planSource?: PlanSource;
}

/**
 * POST /api/admin/notifuse/update-plan
 * Body: { tenantId, plan, reason?, planSource? }
 *
 * Pousse le plan vers le fork Notifuse via HMAC, puis persiste un audit dans
 * `tenant.metadata.notifuse_plan_history` (limité aux 50 dernières entrées).
 */
export async function POST(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tenantId = body.tenantId?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId required' }, { status: 400 });
  }
  if (!isNotifusePlan(body.plan)) {
    return NextResponse.json(
      { error: `plan must be one of: ${NOTIFUSE_PLANS.join(', ')}` },
      { status: 400 },
    );
  }
  const planSource: PlanSource = body.planSource ?? 'manual';
  if (!VALID_SOURCES.includes(planSource)) {
    return NextResponse.json(
      { error: `planSource must be one of: ${VALID_SOURCES.join(', ')}` },
      { status: 400 },
    );
  }

  const resolved = await resolveNotifuseTenant(tenantId);
  if (resolved instanceof NextResponse) return resolved;

  const client = buildNotifuseClient();
  if (client instanceof NextResponse) return client;

  try {
    await client.updatePlan({
      tenantId: resolved.notifuseWorkspaceSlug,
      plan: body.plan,
    });
  } catch (err) {
    return notifuseErrorResponse(err);
  }

  // Audit log (best-effort) — qui a changé le plan + raison + ancien plan.
  const session = await auth();
  const setBy = session?.user?.email ?? 'admin-secret';
  const previousPlan =
    typeof resolved.metadata.notifuse_plan === 'string'
      ? (resolved.metadata.notifuse_plan as string)
      : null;

  const historyEntry = {
    plan: body.plan,
    previous_plan: previousPlan,
    plan_source: planSource,
    reason: body.reason ?? null,
    set_by: setBy,
    set_at: new Date().toISOString(),
  };

  const existingHistory = Array.isArray(resolved.metadata.notifuse_plan_history)
    ? (resolved.metadata.notifuse_plan_history as unknown[])
    : [];
  const nextHistory = [...existingHistory, historyEntry].slice(-50);

  await prisma.tenant.update({
    where: { id: resolved.hubTenantId },
    data: {
      metadata: {
        ...resolved.metadata,
        notifuse_plan: body.plan,
        notifuse_plan_source: planSource,
        notifuse_plan_set_at: historyEntry.set_at,
        notifuse_plan_set_by: setBy,
        notifuse_plan_history: nextHistory,
      } as object,
    },
  });

  // Best-effort log (table déjà utilisée par provision.ts).
  try {
    await prisma.provisioningLog.create({
      data: {
        tenantId: resolved.hubTenantId,
        level: 'info',
        service: 'notifuse',
        message: `Plan changed to ${body.plan}`,
        metadata: historyEntry as object,
      },
    });
  } catch (logErr) {
    console.warn('[admin-notifuse/update-plan] provisioning_log create failed:', logErr);
  }

  return NextResponse.json({
    ok: true,
    tenant_id: resolved.hubTenantId,
    notifuse_workspace_id: resolved.notifuseWorkspaceSlug,
    plan: body.plan,
    plan_source: planSource,
    set_by: setBy,
    set_at: historyEntry.set_at,
  });
}
