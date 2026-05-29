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
 *
 * Signature : les fonctions acceptent un `prisma` optionnel en second
 * argument pour faciliter les tests unitaires (mock client). Par défaut
 * elles utilisent le singleton `@/lib/prisma` — donc les callers métier
 * (page dashboard, routes admin) n'ont qu'à passer l'identifiant.
 */

import type { CrmTenant, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '@/lib/prisma';

/**
 * Union des status possibles côté UI Hub. Le backend ne crée jamais
 * 'provisioning' ni 'error' aujourd'hui (le flow 6-step est synchrone et
 * échoue avant l'INSERT), mais on les conserve dans l'union pour matcher
 * le contrat UI consommé par `app/dashboard/crm/CrmStatusCard.tsx`
 * (variantes visuelles déjà câblées par Agent D). 'deleted' n'est jamais
 * exposé via `getCrmTenantByUserId`/`ByEmail` (filtres status != 'deleted').
 */
/**
 * Status visibles via les helpers de cette lib. `deleted` est volontairement
 * exclu : tous les lookups (`getCrmTenantByUserId`, `getCrmTenantByEmail`)
 * filtrent `status != 'deleted'`, donc l'UI ne peut jamais recevoir cette
 * valeur. On garde `provisioning` + `error` dans l'union pour matcher le
 * contrat consommé par `CrmStatusCard.tsx` (Agent D), même si le backend
 * ne crée pas ces états aujourd'hui (le flow 6-step est synchrone).
 */
export type CrmTenantStatus = 'active' | 'suspended' | 'provisioning' | 'error';

const KNOWN_STATUSES: ReadonlySet<CrmTenantStatus> = new Set<CrmTenantStatus>([
  'active',
  'suspended',
  'provisioning',
  'error',
]);

function coerceStatus(raw: string): CrmTenantStatus {
  return (KNOWN_STATUSES.has(raw as CrmTenantStatus) ? raw : 'error') as CrmTenantStatus;
}

export interface CrmTenantSafeView {
  id: string;
  userId: string;
  email: string;
  workspaceDisplayName: string;
  twentyWorkspaceId: string;
  twentyWorkspaceUrl: string;
  twentyApiKeyId: string;
  twentyApiKeyExpiresAt: Date;
  status: CrmTenantStatus;
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
    status: coerceStatus(row.status),
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
  userUuid: string,
  prisma: PrismaClient = defaultPrisma,
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
  email: string,
  prisma: PrismaClient = defaultPrisma,
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
  id: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<CrmTenant | null> {
  if (!id) return null;
  return prisma.crmTenant.findUnique({ where: { id } });
}
