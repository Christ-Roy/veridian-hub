import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/get-user';
import {
  getCrmTenantByUserId,
  getCrmTenantByEmail,
} from '@/lib/crm/select-tenant';
import {
  createCrmClientFromEnv,
  regenerateMagicLink,
} from '@/lib/crm/client';
import { encryptSecret } from '@/lib/crm/vault';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/dashboard/crm/activate
 *
 * Lazy-provision + auto-login user-side. Si CrmTenant actif existe →
 * régénère un magic-link (decrypt password chiffré, getLoginTokenFromCredentials).
 * Sinon → crée un nouveau tenant Twenty (6 GraphQL calls), stocke chiffré.
 *
 * Le front fait `window.open(magicLinkUrl, '_blank')` pour auto-login Twenty.
 */
export async function POST(_request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !user.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const existingByUser = await getCrmTenantByUserId(user.id);
  const existing =
    existingByUser ?? (await getCrmTenantByEmail(user.email));

  if (existing && existing.status === 'active') {
    try {
      const { magicLinkUrl, expiresAt } = await regenerateMagicLink(
        existing.id,
      );
      return NextResponse.json({
        magicLinkUrl,
        crmTenantId: existing.id,
        workspaceUrl: existing.twentyWorkspaceUrl,
        idempotent: true,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      console.error('[crm/activate] regenerateMagicLink failed', err);
      return NextResponse.json(
        {
          error: 'magic_link_failed',
          message: "Impossible de régénérer le lien d'accès au CRM. Réessaye dans quelques secondes.",
        },
        { status: 502 },
      );
    }
  }

  try {
    const client = createCrmClientFromEnv();
    const workspaceName =
      (user.name && user.name.trim()) ||
      user.email.split('@')[0] ||
      'Mon CRM Veridian';

    const result = await client.createTenant({
      email: user.email,
      workspaceName,
    });

    const passwordEncrypted = encryptSecret(result.passwordGenerated);
    const apiKeyEncrypted = encryptSecret(result.twentyApiKeyToken);

    const crmTenant = await prisma.crmTenant.create({
      data: {
        userId: user.id,
        email: user.email,
        workspaceDisplayName: workspaceName,
        twentyWorkspaceId: result.twentyWorkspaceId,
        twentyWorkspaceUrl: result.twentyWorkspaceUrl,
        twentyApiKeyId: result.twentyApiKeyId,
        twentyApiKeyEncrypted: apiKeyEncrypted,
        twentyApiKeyExpiresAt: result.twentyApiKeyExpiresAt,
        twentyPasswordEncrypted: passwordEncrypted,
        status: 'active',
        provisionedAt: new Date(),
      },
      select: { id: true },
    });

    return NextResponse.json({
      magicLinkUrl: result.initialMagicLinkUrl,
      crmTenantId: crmTenant.id,
      workspaceUrl: result.twentyWorkspaceUrl,
      idempotent: false,
    });
  } catch (err) {
    console.error('[crm/activate] createTenant failed', err);
    const message =
      err instanceof Error ? err.message : 'CRM provisioning failed';
    return NextResponse.json(
      { error: 'crm_provision_failed', message },
      { status: 502 },
    );
  }
}
