import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import {
  buildNotifuseClient,
  notifuseErrorResponse,
  resolveNotifuseTenant,
} from '@/lib/notifuse/admin-helpers';
import { prisma } from '@/lib/prisma';
import { fusionnerMetadata } from '@/lib/tenants/metadata-fusion';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  tenantId?: string;
}

/**
 * POST /api/admin/notifuse/resume
 * Body: { tenantId }
 *
 * Réactive un workspace suspendu côté Notifuse via HMAC. Clear les marqueurs
 * `notifuse_suspended_*` localement (le webhook `tenant.resumed` confirmera
 * idempotemment).
 */
export async function POST(request: NextRequest) {
  const garde = await authenticateAdmin(request);
  if (!garde.ok) return garde.response;

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

  const resolved = await resolveNotifuseTenant(tenantId);
  if (resolved instanceof NextResponse) return resolved;

  const client = buildNotifuseClient();
  if (client instanceof NextResponse) return client;

  try {
    await client.resumeWorkspace({
      tenantId: resolved.notifuseWorkspaceSlug,
    });
  } catch (err) {
    return notifuseErrorResponse(err);
  }

  const session = await auth();
  const resumedBy = session?.user?.email ?? 'admin-secret';
  const resumedAt = new Date().toISOString();

  // Les seules clés de ce geste, fusionnées par la base : jamais le JSON entier relu avant (26/11, lib/tenants/metadata-fusion.ts).
  await fusionnerMetadata(prisma, resolved.hubTenantId, {
    notifuse_suspended_at: null,
    notifuse_suspended_reason: null,
    notifuse_suspended_by: null,
    notifuse_resumed_at: resumedAt,
    notifuse_resumed_by: resumedBy,
  });

  try {
    await prisma.provisioningLog.create({
      data: {
        tenantId: resolved.hubTenantId,
        level: 'info',
        service: 'notifuse',
        message: 'Tenant resumed',
        metadata: { resumed_by: resumedBy, resumed_at: resumedAt },
      },
    });
  } catch (logErr) {
    console.warn('[admin-notifuse/resume] provisioning_log create failed:', logErr);
  }

  return NextResponse.json({
    ok: true,
    tenant_id: resolved.hubTenantId,
    notifuse_workspace_id: resolved.notifuseWorkspaceSlug,
    resumed_at: resumedAt,
    resumed_by: resumedBy,
  });
}
