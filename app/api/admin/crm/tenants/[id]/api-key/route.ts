/**
 * GET /api/admin/crm/tenants/[id]/api-key
 *
 * Révèle le Bearer Twenty API key déchiffré pour un CRM tenant. Permet à
 * Robert (ou son agent) d'utiliser le Bearer pour pousser de la data via
 * `/rest/*` Twenty depuis sa session locale, sans avoir à re-provisionner.
 *
 * ⚠️ Endpoint sensible : audit log à CHAQUE appel + révèle un secret long-
 * lived (1 an). Pas d'usage routinier — réservé aux opérations data
 * ponctuelles (push leads custom, import initial, debug).
 *
 * Auth : `authenticateAdmin`. Audit : `admin.crm.tenant.reveal-api-key`.
 */

import { NextRequest, NextResponse } from 'next/server';

import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { getCrmTenantById } from '@/lib/crm/select-tenant';
import { decryptSecret } from '@/lib/crm/vault';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'missing_id' }, { status: 400 });
  }

  const tenant = await getCrmTenantById(prisma, id);
  if (!tenant) {
    return NextResponse.json({ error: 'tenant_not_found' }, { status: 404 });
  }
  if (tenant.status === 'deleted') {
    return NextResponse.json(
      { error: 'tenant_deleted', message: 'This CRM tenant has been deleted.' },
      { status: 410 },
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptSecret(tenant.twentyApiKeyEncrypted);
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: '[crm-vault-failed]',
        level: 'error',
        context: 'reveal-api-key',
        tenant_id: tenant.id,
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: 'vault_unavailable', message: 'Unable to decrypt API key.' },
      { status: 500 },
    );
  }

  const actor = resolveActor(request.headers, authResult.sessionEmail);
  await writeAuditLog(prisma, {
    action: 'admin.crm.tenant.reveal-api-key',
    actor,
    targetType: 'tenant',
    targetId: tenant.id,
    payload: {
      email: tenant.email,
      twenty_workspace_id: tenant.twentyWorkspaceId,
      twenty_api_key_id: tenant.twentyApiKeyId,
      expires_at: tenant.twentyApiKeyExpiresAt.toISOString(),
    },
  });

  return NextResponse.json({
    apiKey,
    expiresAt: tenant.twentyApiKeyExpiresAt.toISOString(),
    workspaceId: tenant.twentyWorkspaceId,
    workspaceUrl: tenant.twentyWorkspaceUrl,
  });
}
