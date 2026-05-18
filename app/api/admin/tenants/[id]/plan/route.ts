// POST /api/admin/tenants/[id]/plan — endpoint admin unifié pour les plans.
//
// Body : { app: 'notifuse' | 'prospection', plan: string, trialEndsAt?: string | null }
//
// Comportement :
//   - notifuse : valide contre NOTIFUSE_PLANS (incl. lifetime_*, internal),
//     pousse à Notifuse via updatePlan() HMAC, écrit `notifusePlan` en DB +
//     met aussi à jour metadata.notifuse_plan pour rétrocompat.
//   - prospection : valide contre la liste prospection ('freemium', 'pro',
//     'enterprise'), écrit `prospectionPlan`. Le push vers Prospection n'est
//     pas encore câblé côté app (ticket déposé) — pour l'instant, DB seule.
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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROSPECTION_PLANS = ['freemium', 'starter', 'pro', 'enterprise'] as const;
type ProspectionPlan = (typeof PROSPECTION_PLANS)[number];

interface RequestBody {
  app?: 'notifuse' | 'prospection';
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

  if (body.app !== 'notifuse' && body.app !== 'prospection') {
    return NextResponse.json(
      { error: 'app must be "notifuse" or "prospection"' },
      { status: 400 },
    );
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      notifuseWorkspaceSlug: true,
      notifusePlan: true,
      prospectionPlan: true,
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

  // NB : pas encore de propagation HMAC vers Prospection (ticket déposé dans
  // `todo/integrations/prospection-update-plan-2026-05-18.md`). DB seule pour
  // l'instant — le sync Stripe→Prisma existant continue de marcher.

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
    warning:
      'Prospection app n\'expose pas encore /update-plan HMAC — plan stocké côté Hub uniquement.',
  });
}
