import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  buildNotifuseClient,
  notifuseErrorResponse,
  resolveNotifuseTenant,
} from '@/lib/notifuse/admin-helpers';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  tenantId?: string;
  reason?: string;
}

/**
 * POST /api/admin/notifuse/suspend
 * Body: { tenantId, reason }
 *
 * Suspend le workspace Notifuse via HMAC. Le webhook `tenant.suspended`
 * sortant de Notifuse mettra à jour `tenant.metadata.notifuse_suspended_at`
 * de façon canonique — on l'écrit aussi ici pour avoir la valeur immédiate
 * sans attendre le round-trip webhook.
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

  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json(
      { error: 'reason required (used for audit + tenant-facing message)' },
      { status: 400 },
    );
  }

  const resolved = await resolveNotifuseTenant(tenantId);
  if (resolved instanceof NextResponse) return resolved;

  const client = buildNotifuseClient();
  if (client instanceof NextResponse) return client;

  try {
    await client.suspendWorkspace({
      tenantId: resolved.notifuseWorkspaceSlug,
      reason,
    });
  } catch (err) {
    return notifuseErrorResponse(err);
  }

  const session = await auth();
  const suspendedBy = session?.user?.email ?? 'admin-secret';
  const suspendedAt = new Date().toISOString();

  await prisma.tenant.update({
    where: { id: resolved.hubTenantId },
    data: {
      metadata: {
        ...resolved.metadata,
        notifuse_suspended_at: suspendedAt,
        notifuse_suspended_reason: reason,
        notifuse_suspended_by: suspendedBy,
      } as object,
    },
  });

  try {
    await prisma.provisioningLog.create({
      data: {
        tenantId: resolved.hubTenantId,
        level: 'warning',
        service: 'notifuse',
        message: `Tenant suspended: ${reason}`,
        metadata: { suspended_by: suspendedBy, suspended_at: suspendedAt, reason },
      },
    });
  } catch (logErr) {
    console.warn('[admin-notifuse/suspend] provisioning_log create failed:', logErr);
  }

  return NextResponse.json({
    ok: true,
    tenant_id: resolved.hubTenantId,
    notifuse_workspace_id: resolved.notifuseWorkspaceSlug,
    suspended_at: suspendedAt,
    suspended_by: suspendedBy,
    reason,
  });
}
