/**
 * POST /api/admin/crm/tenants/[id]/magic-link
 *
 * Régénère un magic link auto-login pour un CRM tenant existant.
 * Utilisé par :
 *  - Robert (admin) qui veut renvoyer un lien à un client
 *  - L'UI dashboard `/dashboard/crm` (bouton "Ouvrir mon CRM")
 *
 * Le password Twenty stocké chiffré est déchiffré juste le temps d'appeler
 * `getLoginTokenFromCredentials` côté CRM, jamais retourné ni loggué.
 *
 * Auth : `authenticateAdmin`. Audit : `admin.crm.tenant.regenerate-magic-link`.
 */

import { NextRequest, NextResponse } from 'next/server';

import { writeAuditLog, resolveActor } from '@/lib/admin/audit-log';
import { authenticateAdmin } from '@/lib/admin/authenticate';
import { createCrmClientFromEnv } from '@/lib/crm/client';
import { getCrmTenantById } from '@/lib/crm/select-tenant';
import { CrmClientError } from '@/lib/crm/types';
import { decryptSecret } from '@/lib/crm/vault';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authResult = await authenticateAdmin(request);
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'missing_id' }, { status: 400 });
  }

  const tenant = await getCrmTenantById(id);
  if (!tenant) {
    return NextResponse.json({ error: 'tenant_not_found' }, { status: 404 });
  }
  if (tenant.status === 'deleted') {
    return NextResponse.json(
      { error: 'tenant_deleted', message: 'This CRM tenant has been deleted.' },
      { status: 410 },
    );
  }

  let magicLinkUrl: string;
  let expiresAt: Date;
  try {
    const password = decryptSecret(tenant.twentyPasswordEncrypted);
    const client = createCrmClientFromEnv();
    const result = await client.regenerateMagicLink({
      email: tenant.email,
      passwordDecrypted: password,
      workspaceUrl: tenant.twentyWorkspaceUrl,
    });
    magicLinkUrl = result.magicLinkUrl;
    expiresAt = result.expiresAt;
  } catch (err) {
    if (err instanceof CrmClientError) {
      console.error(
        JSON.stringify({
          tag: '[crm-client-error]',
          level: 'error',
          context: 'regenerate-magic-link',
          step: err.step,
          status: err.status,
          message: err.message,
          ts: new Date().toISOString(),
        }),
      );
      return NextResponse.json(
        { error: 'crm_upstream_error', step: err.step, message: err.message },
        { status: 502 },
      );
    }
    console.error(
      JSON.stringify({
        tag: '[crm-unknown-error]',
        level: 'error',
        context: 'regenerate-magic-link',
        message: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: 'internal_error', message: 'Unable to regenerate magic link.' },
      { status: 500 },
    );
  }

  const actor = resolveActor(request.headers, authResult.sessionEmail);
  await writeAuditLog(prisma, {
    action: 'admin.crm.tenant.regenerate-magic-link',
    actor,
    targetType: 'tenant',
    targetId: tenant.id,
    payload: {
      email: tenant.email,
      twenty_workspace_id: tenant.twentyWorkspaceId,
      expires_at: expiresAt.toISOString(),
    },
  });

  return NextResponse.json({
    magicLinkUrl,
    expiresAt: expiresAt.toISOString(),
  });
}
