// POST /api/admin/tenants/[id]/plan — endpoint admin unifié pour les plans.
//
// Body : { app: 'notifuse' | 'prospection' | 'analytics' | 'crm', plan: string, trialEndsAt?: string | null }
//
// Comportement :
//   - notifuse : valide contre NOTIFUSE_PLANS (incl. lifetime_*, internal),
//     pousse à Notifuse via updatePlan() HMAC, écrit `notifusePlan` en DB +
//     met aussi à jour metadata.notifuse_plan pour rétrocompat.
//   - prospection : valide contre la liste prospection, pousse à Prospection si
//     le tenant y est provisionné (`lib/prospection/plan-push.ts`), puis écrit
//     `prospectionPlan`. Un refus de l'app n'écrit rien : pas d'écart silencieux.
//   - analytics, crm : plan canonique (free, pro, business, enterprise), poussé à l'app
//     (`lib/plans/app-plan.ts`) puis écrit dans `metadata.<app>_plan`. Refus de l'app : rien écrit.
//   - trialEndsAt : si présent dans le body, met à jour le champ Tenant.
//     `null` = pas d'expiration (free pour toujours). Absent = pas de
//     modification.
//
// Auth : requireAdmin (session admin ou x-admin-secret).
//
// Remplace /api/admin/grant-plan (qui reste en alias deprecated).

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { requireAdmin } from '@/lib/admin/require-admin';
import { buildNotifuseClient } from '@/lib/notifuse/admin-helpers';
import { isNotifusePlan, NOTIFUSE_PLANS, NotifuseError } from '@/lib/notifuse/types';
import { prisma } from '@/lib/prisma';
import { pushProspectionPlan } from '@/lib/prospection/plan-push';
import { CANONICAL_PLANS, isCanonicalPlan, PLAN_APPS, setAppPlan, tenantHasApp, type PlanApp } from '@/lib/plans/app-plan';
import { trialStatusForTenant } from '@/lib/plans/trial-status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROSPECTION_PLANS = ['freemium', 'pro', 'business', 'enterprise'] as const;
type ProspectionPlan = (typeof PROSPECTION_PLANS)[number];

interface RequestBody {
  app?: 'notifuse' | 'prospection' | PlanApp;
  plan?: string;
  trialEndsAt?: string | null;
  reason?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  const { id: tenantId } = await params;
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId required in URL' }, { status: 400 });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const planApp = (PLAN_APPS as readonly string[]).includes(body.app ?? '') ? (body.app as PlanApp) : null;
  if (body.app !== 'notifuse' && body.app !== 'prospection' && !planApp) {
    return NextResponse.json(
      { error: 'app must be "notifuse", "prospection", "analytics" or "crm"' },
      { status: 400 },
    );
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      notifuseWorkspaceSlug: true,
      userId: true,
      notifusePlan: true,
      prospectionPlan: true,
      prospectionProvisionedAt: true,
      trialEndsAt: true,
      metadata: true,
    },
  });

  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  const session = await auth();
  const setBy = session?.user?.email ?? 'admin-secret';
  const setAt = new Date().toISOString();

  // Trial — validé indépendamment de l'app
  let trialUpdate: Date | null | undefined;
  if (body.trialEndsAt !== undefined) {
    if (body.trialEndsAt === null) {
      trialUpdate = null;
    } else {
      const parsed = new Date(body.trialEndsAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: 'trialEndsAt must be ISO 8601 or null' },
          { status: 400 },
        );
      }
      trialUpdate = parsed;
    }
  }

  // ============== ANALYTICS, CRM ==============
  if (planApp) {
    if (!isCanonicalPlan(body.plan)) {
      return NextResponse.json({ error: `plan must be one of: ${CANONICAL_PLANS.join(', ')}` }, { status: 400 });
    }
    if (!tenantHasApp(tenant.metadata, planApp)) {
      return NextResponse.json({ error: `Tenant has no ${planApp} — activate it first` }, { status: 409 });
    }
    const pushed = await setAppPlan(prisma, {
      tenantId,
      app: planApp,
      plan: body.plan,
      planSource: 'grant_manual',
      reason: body.reason ?? null,
      setBy,
    });
    if (!pushed.ok) {
      return NextResponse.json({ error: `${planApp} rejected plan update: ${pushed.error}` }, { status: 502 });
    }
    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'info',
          service: planApp,
          message: `Plan ${planApp} → ${body.plan}`,
          metadata: { plan: body.plan, reason: body.reason ?? null, set_by: setBy, set_at: setAt } as object,
        },
      });
    } catch (logErr) {
      console.warn('[admin/tenants/plan] provisioning_log create failed:', logErr);
    }
    return NextResponse.json({
      ok: true,
      tenant_id: tenantId,
      app: planApp,
      plan: body.plan,
      previous_plan: 'previousPlan' in pushed ? pushed.previousPlan : null,
      set_by: setBy,
      set_at: setAt,
      propagated: true,
    });
  }

  // ============== NOTIFUSE ==============
  if (body.app === 'notifuse') {
    if (!isNotifusePlan(body.plan)) {
      return NextResponse.json(
        { error: `plan must be one of: ${NOTIFUSE_PLANS.join(', ')}` },
        { status: 400 },
      );
    }

    if (!tenant.notifuseWorkspaceSlug) {
      return NextResponse.json(
        { error: 'Tenant has no Notifuse workspace — provision it first' },
        { status: 409 },
      );
    }

    const client = buildNotifuseClient();
    if (client instanceof NextResponse) return client;

    try {
      await client.updatePlan({
        tenantId: tenant.notifuseWorkspaceSlug,
        plan: body.plan,
        trial: await trialStatusForTenant(prisma, tenantId),
        hubTenantId: tenantId,
      });
    } catch (err) {
      if (err instanceof NotifuseError) {
        return NextResponse.json(
          { error: `Notifuse rejected plan update: ${err.message}`, code: err.code },
          { status: 502 },
        );
      }
      throw err;
    }

    const previousPlan = tenant.notifusePlan ?? 'free';
    const existingMeta = (tenant.metadata as Record<string, unknown> | null) ?? {};
    const historyEntry = {
      plan: body.plan,
      previous_plan: previousPlan,
      reason: body.reason ?? null,
      set_by: setBy,
      set_at: setAt,
    };
    const existingHistory = Array.isArray(existingMeta.notifuse_plan_history)
      ? (existingMeta.notifuse_plan_history as unknown[])
      : [];
    const nextHistory = [...existingHistory, historyEntry].slice(-50);

    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        notifusePlan: body.plan,
        ...(trialUpdate !== undefined ? { trialEndsAt: trialUpdate } : {}),
        metadata: {
          ...existingMeta,
          notifuse_plan: body.plan,
          notifuse_plan_set_at: setAt,
          notifuse_plan_set_by: setBy,
          notifuse_plan_history: nextHistory,
        } as object,
      },
      select: {
        id: true,
        notifusePlan: true,
        prospectionPlan: true,
        trialEndsAt: true,
      },
    });

    try {
      await prisma.provisioningLog.create({
        data: {
          tenantId,
          level: 'info',
          service: 'notifuse',
          message: `Plan ${body.app} → ${body.plan}`,
          metadata: historyEntry as object,
        },
      });
    } catch (logErr) {
      console.warn('[admin/tenants/plan] provisioning_log create failed:', logErr);
    }

    return NextResponse.json({
      ok: true,
      tenant_id: updated.id,
      app: 'notifuse',
      plan: updated.notifusePlan,
      trial_ends_at: updated.trialEndsAt,
      set_by: setBy,
      set_at: setAt,
    });
  }

  // ============== PROSPECTION ==============
  // body.app === 'prospection' (garde du discriminator ci-dessus)
  if (!(PROSPECTION_PLANS as readonly string[]).includes(body.plan ?? '')) {
    return NextResponse.json(
      { error: `plan must be one of: ${PROSPECTION_PLANS.join(', ')}` },
      { status: 400 },
    );
  }
  const prospectionPlan = body.plan as ProspectionPlan;

  let propagated = false;
  if (tenant.prospectionProvisionedAt) {
    const owner = await prisma.user.findFirst({
      where: { supabaseUserId: tenant.userId },
      select: { email: true },
    });
    if (!owner) {
      return NextResponse.json({ error: 'Tenant owner not found' }, { status: 409 });
    }
    const pushed = await pushProspectionPlan({
      hubTenantId: tenant.id,
      email: owner.email,
      plan: prospectionPlan,
      planSource: 'grant_manual',
      reason: body.reason,
      trial: await trialStatusForTenant(prisma, tenantId),
    });
    if (!pushed.ok) {
      return NextResponse.json(
        { error: `Prospection rejected plan update: ${pushed.error}` },
        { status: 502 },
      );
    }
    propagated = true;
  }

  const updated = await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      prospectionPlan,
      ...(trialUpdate !== undefined ? { trialEndsAt: trialUpdate } : {}),
    },
    select: {
      id: true,
      notifusePlan: true,
      prospectionPlan: true,
      trialEndsAt: true,
    },
  });

  try {
    await prisma.provisioningLog.create({
      data: {
        tenantId,
        level: 'info',
        service: 'prospection',
        message: `Plan prospection → ${prospectionPlan}`,
        metadata: {
          plan: prospectionPlan,
          reason: body.reason ?? null,
          set_by: setBy,
          set_at: setAt,
        },
      },
    });
  } catch (logErr) {
    console.warn('[admin/tenants/plan] provisioning_log create failed:', logErr);
  }

  return NextResponse.json({
    ok: true,
    tenant_id: updated.id,
    app: 'prospection',
    plan: updated.prospectionPlan,
    trial_ends_at: updated.trialEndsAt,
    set_by: setBy,
    set_at: setAt,
    propagated,
  });
}
