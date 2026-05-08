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
  confirm?: unknown;
}

/**
 * DELETE /api/admin/notifuse/delete
 * Body: { tenantId, confirm: true }
 *
 * Soft-delete côté fork Notifuse (fenêtre 30j de réactivation, après quoi un
 * cron paresseux purge). On marque le tenant Hub côté metadata pour que
 * l'UI puisse afficher la bannière "workspace en cours de suppression".
 *
 * NB : NE TOUCHE PAS au tenant Hub côté status — il reste actif tant que le
 * user n'est pas explicitement supprimé via /api/admin/delete-tenant.
 */
export async function DELETE(request: NextRequest) {
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
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: 'Set confirm: true to proceed (destructive — soft-delete on Notifuse side)' },
      { status: 400 },
    );
  }

  const resolved = await resolveNotifuseTenant(tenantId);
  if (resolved instanceof NextResponse) return resolved;

  const client = buildNotifuseClient();
  if (client instanceof NextResponse) return client;

  try {
    await client.deleteWorkspace(resolved.notifuseWorkspaceSlug);
  } catch (err) {
    return notifuseErrorResponse(err);
  }

  const session = await auth();
  const deletedBy = session?.user?.email ?? 'admin-secret';
  const deletedAt = new Date().toISOString();

  await prisma.tenant.update({
    where: { id: resolved.hubTenantId },
    data: {
      metadata: {
        ...resolved.metadata,
        notifuse_deleted_at: deletedAt,
        notifuse_deleted_by: deletedBy,
      } as object,
    },
  });

  try {
    await prisma.provisioningLog.create({
      data: {
        tenantId: resolved.hubTenantId,
        level: 'warning',
        service: 'notifuse',
        message: 'Notifuse workspace soft-deleted (30d retention)',
        metadata: { deleted_by: deletedBy, deleted_at: deletedAt },
      },
    });
  } catch (logErr) {
    console.warn('[admin-notifuse/delete] provisioning_log create failed:', logErr);
  }

  return NextResponse.json({
    ok: true,
    tenant_id: resolved.hubTenantId,
    notifuse_workspace_id: resolved.notifuseWorkspaceSlug,
    deleted_at: deletedAt,
    deleted_by: deletedBy,
    note: 'Soft-delete — tenant Hub still active. Re-provision blocked for 30 days on Notifuse side.',
  });
}
