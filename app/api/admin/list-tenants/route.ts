import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { isPlatformAdmin } from '@/lib/admin/check-admin';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = request.headers.get('x-admin-secret');
  if (adminSecret && headerSecret === adminSecret) return null;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isPlatformAdmin(session.user)) {
    return NextResponse.json({ error: 'Forbidden — admin access only' }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/admin/list-tenants
 * Lists all tenants with user info and service status.
 */
export async function GET(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: 'desc' },
  });

  // Build email map (User.supabaseUserId → email/createdAt)
  const userUuids = Array.from(
    new Set(tenants.map((t) => t.userId).filter(Boolean) as string[]),
  );
  const users = userUuids.length
    ? await prisma.user.findMany({
        where: { supabaseUserId: { in: userUuids } },
        select: { supabaseUserId: true, email: true, createdAt: true },
      })
    : [];
  const userMap = new Map(
    users.map((u) => [u.supabaseUserId!, { email: u.email, created_at: u.createdAt }]),
  );

  const result = tenants.map((t) => {
    const meta = (t.metadata as Record<string, unknown> | null) ?? {};
    return {
      tenant_id: t.id,
      user_id: t.userId,
      email: userMap.get(t.userId)?.email ?? 'unknown',
      user_created: userMap.get(t.userId)?.created_at ?? null,
      name: t.name,
      status: t.status,
      plan: t.prospectionPlan ?? 'freemium',
      trial_ends_at: t.trialEndsAt,
      services: {
        prospection: {
          provisioned: !!t.prospectionProvisionedAt,
          provisioned_at: t.prospectionProvisionedAt,
          plan: t.prospectionPlan,
        },
        twenty: {
          provisioned: !!t.twentyWorkspaceId,
          workspace_id: t.twentyWorkspaceId,
          subdomain: t.twentySubdomain,
        },
        notifuse: {
          provisioned: !!t.notifuseWorkspaceSlug,
          workspace_id: t.notifuseWorkspaceSlug,
          plan: typeof meta.notifuse_plan === 'string' ? meta.notifuse_plan : null,
          plan_source:
            typeof meta.notifuse_plan_source === 'string' ? meta.notifuse_plan_source : null,
          suspended_at:
            typeof meta.notifuse_suspended_at === 'string' ? meta.notifuse_suspended_at : null,
          suspended_reason:
            typeof meta.notifuse_suspended_reason === 'string'
              ? meta.notifuse_suspended_reason
              : null,
          deleted_at:
            typeof meta.notifuse_deleted_at === 'string' ? meta.notifuse_deleted_at : null,
        },
      },
      created_at: t.createdAt,
    };
  });

  return NextResponse.json({
    total: result.length,
    tenants: result,
  });
}
