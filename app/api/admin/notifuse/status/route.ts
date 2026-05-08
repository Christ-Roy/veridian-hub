import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin/require-admin';
import {
  buildNotifuseClient,
  notifuseErrorResponse,
  resolveNotifuseTenant,
} from '@/lib/notifuse/admin-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/notifuse/status?tenantId=<hub_tenant_id>
 *
 * Read-through au fork Notifuse via HMAC. Renvoie l'état canonical du
 * workspace : status (active/suspended/deleted), plan, quota mensuel,
 * emails envoyés, dates de suspend/delete.
 *
 * Utilisé par l'UI admin pour rafraîchir après une action (update-plan,
 * suspend, resume, delete) sans avoir à attendre le webhook.
 */
export async function GET(request: NextRequest) {
  const denial = await requireAdmin(request);
  if (denial) return denial;

  const tenantId = request.nextUrl.searchParams.get('tenantId')?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: 'tenantId query param required' }, { status: 400 });
  }

  const resolved = await resolveNotifuseTenant(tenantId);
  if (resolved instanceof NextResponse) return resolved;

  const client = buildNotifuseClient();
  if (client instanceof NextResponse) return client;

  try {
    const status = await client.getStatus(resolved.notifuseWorkspaceSlug);
    // On renomme `tenant_id` venant du fork (= notifuse workspace_id) pour ne pas
    // collisionner avec le tenant_id côté Hub. Le reste du payload (status, plan,
    // monthly_email_quota, emails_sent_this_month, quota_remaining, suspended_at,
    // deleted_at) est exposé tel quel.
    const { tenant_id: _notifuseTenantId, ...rest } = status;
    return NextResponse.json({
      ok: true,
      tenant_id: resolved.hubTenantId,
      notifuse_workspace_id: resolved.notifuseWorkspaceSlug,
      ...rest,
    });
  } catch (err) {
    return notifuseErrorResponse(err);
  }
}
