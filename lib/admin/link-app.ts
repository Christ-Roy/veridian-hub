/**
 * Helpers admin pour lier un user Hub à un tenant côté app downstream.
 *
 * Stratégie de stockage par app :
 *  - Notifuse   : colonnes dédiées `notifuse_workspace_slug`, `notifuse_user_email`,
 *                 `notifuse_api_key`, `notifuse_plan`
 *  - Prospection: colonnes dédiées `prospection_*`
 *  - CMS        : stocké dans `tenants.metadata.cms` (JSON) — pas de colonnes
 *                 typées encore (pattern discovery cible cf. ticket associé)
 *  - Analytics  : `tenants.metadata.analytics` (idem)
 *
 * Idempotence : si le user n'a pas encore de row `tenants`, on en crée une.
 * Si la row existe pour ce user, on update les champs concernés.
 *
 * ⚠️ Cette lib n'écrit JAMAIS dans audit_log directement — c'est l'appelant
 * (la route admin) qui doit s'en charger après succès, pour garder la
 * lib pure et facilement testable.
 */

import type { PrismaClient, Tenant } from '@prisma/client';

export type AppLinkApp = 'cms' | 'analytics' | 'notifuse' | 'prospection';

export type LinkAppInput = {
  /** UUID supabase du user Hub (= Tenant.userId) */
  userUuid: string;
  app: AppLinkApp;
  externalTenantId: string;
  externalTenantSlug: string;
  tenantName: string;
  plan?: string;
  fallbackUrl?: string;
  magicLinkCapable?: boolean;
  provisioningSource?: string;
  notes?: string;
};

export type LinkAppResult = {
  tenantId: string;
  userUuid: string;
  app: AppLinkApp;
  metadataPath: string;
  created: boolean; // true si on a inséré une nouvelle row Tenant
};

/**
 * Lie le user Hub à un tenant côté app downstream.
 * Idempotent : si déjà lié, met à jour les champs (sans toucher aux autres apps).
 */
export async function linkApp(
  prisma: PrismaClient,
  input: LinkAppInput
): Promise<LinkAppResult> {
  const existing = await prisma.tenant.findFirst({
    where: { userId: input.userUuid },
  });

  const appPayload = {
    external_tenant_id: input.externalTenantId,
    external_tenant_slug: input.externalTenantSlug,
    tenant_name: input.tenantName,
    plan: input.plan ?? null,
    fallback_url: input.fallbackUrl ?? null,
    magic_link_capable: input.magicLinkCapable ?? false,
    provisioning_source: input.provisioningSource ?? 'admin-api',
    notes: input.notes ?? null,
    linked_at: new Date().toISOString(),
  };

  if (existing) {
    const updated = await applyAppToTenant(prisma, existing, input, appPayload);
    return {
      tenantId: updated.id,
      userUuid: input.userUuid,
      app: input.app,
      metadataPath: `tenants.metadata.${input.app}`,
      created: false,
    };
  }

  // Nouvelle row Tenant : champs minimaux + payload spécifique à l'app
  const baseData: Record<string, unknown> = {
    userId: input.userUuid,
    name: input.tenantName,
    slug: `admin-${input.app}-${input.externalTenantSlug}-${Date.now()}`,
    status: 'active',
    provisionedAt: new Date(),
    metadata: buildMetadataForApp(null, input.app, appPayload),
  };

  Object.assign(baseData, dedicatedColumnsForApp(input.app, input));

  const created = await prisma.tenant.create({
    data: baseData as never,
  });

  return {
    tenantId: created.id,
    userUuid: input.userUuid,
    app: input.app,
    metadataPath: `tenants.metadata.${input.app}`,
    created: true,
  };
}

async function applyAppToTenant(
  prisma: PrismaClient,
  existing: Tenant,
  input: LinkAppInput,
  appPayload: Record<string, unknown>
) {
  const updateData: Record<string, unknown> = {
    metadata: buildMetadataForApp(existing.metadata, input.app, appPayload),
  };
  Object.assign(updateData, dedicatedColumnsForApp(input.app, input));

  return prisma.tenant.update({
    where: { id: existing.id },
    data: updateData as never,
  });
}

function buildMetadataForApp(
  current: Tenant['metadata'] | null,
  app: AppLinkApp,
  appPayload: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  base[app] = appPayload;
  return base;
}

function dedicatedColumnsForApp(
  app: AppLinkApp,
  input: LinkAppInput
): Record<string, unknown> {
  switch (app) {
    case 'notifuse':
      return {
        notifuseWorkspaceSlug: input.externalTenantSlug,
        notifuseUserEmail: input.notes?.includes('@') ? input.notes : undefined,
        notifusePlan: input.plan ?? 'free',
      };
    case 'prospection':
      return {
        prospectionPlan: input.plan ?? 'freemium',
        prospectionProvisionedAt: new Date(),
      };
    // cms / analytics : tout dans metadata, pas de colonnes dédiées
    case 'cms':
    case 'analytics':
    default:
      return {};
  }
}

/**
 * Soft unlink : retire l'app de metadata (et reset les colonnes dédiées
 * pour notifuse/prospection si concerné), sans supprimer la row Tenant.
 * Si après l'unlink le Tenant n'a plus aucune app, on le laisse quand même
 * en DB pour préserver l'historique (deletedAt restera null tant que pas
 * de purge explicite).
 */
export async function unlinkApp(
  prisma: PrismaClient,
  input: { userUuid: string; app: AppLinkApp }
): Promise<{ tenantId: string; unlinked: boolean }> {
  const existing = await prisma.tenant.findFirst({
    where: { userId: input.userUuid },
  });

  if (!existing) {
    return { tenantId: '', unlinked: false };
  }

  const metadata =
    existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? { ...(existing.metadata as Record<string, unknown>) }
      : {};
  const wasPresent = input.app in metadata;
  delete metadata[input.app];

  const updateData: Record<string, unknown> = { metadata };
  // Reset colonnes dédiées si l'app les utilisait
  if (input.app === 'notifuse') {
    updateData.notifuseWorkspaceSlug = null;
    updateData.notifuseUserEmail = null;
    updateData.notifuseApiKey = null;
    updateData.notifusePlan = null;
  } else if (input.app === 'prospection') {
    updateData.prospectionApiKey = null;
    updateData.prospectionPlan = null;
    updateData.prospectionProvisionedAt = null;
  }

  await prisma.tenant.update({
    where: { id: existing.id },
    data: updateData as never,
  });

  return { tenantId: existing.id, unlinked: wasPresent };
}
