/**
 * Activation des apps "gated" par tenant — panneau d'admin SaaS.
 *
 * Robert (gestionnaire SaaS) active/désactive une app pour un tenant via
 * l'Admin API. Le dashboard lit ces flags pour décider quelles cards de
 * services pas-encore-grand-public afficher comme "actives".
 *
 * Modèle (décision 2026-05-29) :
 *   - DÉFAUT OFF : sans row `TenantApp.enabled=true`, l'app est désactivée.
 *   - Apps GATED : twenty (CRM), analytics, cms — pas prêtes pour le grand
 *     public, activées au cas par cas par tenant.
 *   - Apps GRAND PUBLIC : prospection, notifuse — TOUJOURS visibles, jamais
 *     gérées par ce système (ne pas les passer ici).
 */

import type { PrismaClient } from '@prisma/client';

/** Apps gérées par le système d'activation par tenant (gated, défaut OFF). */
export const GATED_APP_KEYS = ['twenty', 'analytics', 'cms'] as const;
export type GatedAppKey = (typeof GATED_APP_KEYS)[number];

/** True si `key` est une app gated valide. */
export function isGatedAppKey(key: string): key is GatedAppKey {
  return (GATED_APP_KEYS as readonly string[]).includes(key);
}

/**
 * Retourne l'ensemble des apps gated ACTIVÉES pour un tenant (par son UUID
 * bridge). Une app absente de la table = désactivée (défaut OFF).
 *
 * Best-effort : toute erreur DB renvoie un Set vide (le dashboard reste
 * affichable, toutes les apps gated retombent OFF — fail-safe : on ne
 * révèle JAMAIS une app par accident sur une erreur).
 */
export async function getEnabledGatedApps(
  prisma: Pick<PrismaClient, 'tenantApp'>,
  userUuidValue: string,
): Promise<Set<GatedAppKey>> {
  try {
    const rows = await prisma.tenantApp.findMany({
      where: { userId: userUuidValue, enabled: true },
      select: { appKey: true },
    });
    const enabled = new Set<GatedAppKey>();
    for (const row of rows) {
      if (isGatedAppKey(row.appKey)) enabled.add(row.appKey);
    }
    return enabled;
  } catch {
    // Fail-safe : sur erreur DB, aucune app gated n'est révélée.
    return new Set<GatedAppKey>();
  }
}

/**
 * Active ou désactive une app gated pour un tenant (upsert idempotent).
 * Utilisé par l'Admin API. Retourne l'état final `{ appKey, enabled }`.
 */
export async function setTenantAppEnabled(
  prisma: Pick<PrismaClient, 'tenantApp'>,
  params: {
    userUuid: string;
    appKey: GatedAppKey;
    enabled: boolean;
    actorEmail?: string | null;
  },
): Promise<{ appKey: GatedAppKey; enabled: boolean }> {
  const { userUuid, appKey, enabled, actorEmail } = params;
  await prisma.tenantApp.upsert({
    where: { userId_appKey: { userId: userUuid, appKey } },
    create: {
      userId: userUuid,
      appKey,
      enabled,
      enabledAt: enabled ? new Date() : null,
      enabledBy: enabled ? (actorEmail ?? null) : null,
    },
    update: {
      enabled,
      enabledAt: enabled ? new Date() : null,
      enabledBy: enabled ? (actorEmail ?? null) : null,
    },
  });
  return { appKey, enabled };
}
