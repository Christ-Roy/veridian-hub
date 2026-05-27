/**
 * Helpers DB pour consulter les CRM tenants (Twenty fork) depuis le Hub.
 *
 * Utilisé par :
 *  - Le dashboard `/dashboard/crm` (afficher status + bouton "Ouvrir mon CRM")
 *  - L'admin pour idempotence du POST create-tenant (lookup par email)
 *  - Les routes compagnon magic-link / api-key (lookup par id)
 *
 * ⚠️ Ces helpers ne déchiffrent JAMAIS twenty_api_key_encrypted ni
 * twenty_password_encrypted — c'est la responsabilité explicite du caller
 * via `lib/crm/vault.ts#decryptSecret`. On évite ainsi tout déchiffrement
 * accidentel pour de simples lectures dashboard.
 */

import type { CrmTenant, PrismaClient } from '@prisma/client';

export type CrmTenantStatus = 'active' | 'suspended' | 'deleted';

export interface CrmTenantSafeView {
  id: string;
  userId: string;
  email: string;
  workspaceDisplayName: string;
  twentyWorkspaceId: string;
  twentyWorkspaceUrl: string;
  twentyApiKeyId: string;
  twentyApiKeyExpiresAt: Date;
  status: string;
  provisionedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSafeView(row: CrmTenant): CrmTenantSafeView {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    workspaceDisplayName: row.workspaceDisplayName,
    twentyWorkspaceId: row.twentyWorkspaceId,
    twentyWorkspaceUrl: row.twentyWorkspaceUrl,
    twentyApiKeyId: row.twentyApiKeyId,
    twentyApiKeyExpiresAt: row.twentyApiKeyExpiresAt,
    status: row.status,
    provisionedAt: row.provisionedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Retourne le CRM tenant actif du user (s'il y en a un).
 * Un user ne peut avoir qu'UN crm_tenant actif à la fois (1 workspace
 * Twenty par compte Veridian). Les rows `status='deleted'` sont ignorées.
 */
export async function getCrmTenantByUserId(
  prisma: PrismaClient,
  userUuid: string,
): Promise<CrmTenantSafeView | null> {
  if (!userUuid) return null;
  const row = await prisma.crmTenant.findFirst({
    where: { userId: userUuid, status: { not: 'deleted' } },
    orderBy: { createdAt: 'desc' },
  });
  return row ? toSafeView(row) : null;
}

/**
 * Lookup par email — utilisé pour l'idempotence du POST create-tenant.
 * Ignore les rows `status='deleted'` (un email peut être réutilisé après
 * suppression d'un ancien tenant).
 */
export async function getCrmTenantByEmail(
  prisma: PrismaClient,
  email: string,
): Promise<CrmTenantSafeView | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const row = await prisma.crmTenant.findFirst({
    where: { email: normalized, status: { not: 'deleted' } },
  });
  return row ? toSafeView(row) : null;
}

/**
 * Lookup par id — utilisé par les routes compagnon. Retourne la row brute
 * (avec les colonnes chiffrées) car le caller a justement besoin de les
 * déchiffrer.
 */
export async function getCrmTenantById(
  prisma: PrismaClient,
  id: string,
): Promise<CrmTenant | null> {
  if (!id) return null;
  return prisma.crmTenant.findUnique({ where: { id } });
}
