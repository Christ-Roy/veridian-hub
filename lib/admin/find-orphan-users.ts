/**
 * Détection des users Hub orphelins.
 *
 * Définition stricte d'un "user orphelin" :
 *  - row dans `hub_app.users`
 *  - createdAt > `minAgeDays` (par défaut 7 jours)
 *  - AUCUN row dans `accounts` (= jamais loggué via OAuth ni Credentials)
 *  - AUCUN row dans `sessions` (= jamais établi de session active)
 *  - AUCUN row dans `mfaCodes` (= jamais reçu de code MFA)
 *  - AUCUN row dans `tenants` (= jamais provisionné de workspace)
 *
 * Le filtre `tenants` est CRITIQUE : un user qui a un Tenant n'est jamais
 * orphelin, même temporairement, parce qu'il a un workspace facturable
 * derrière lui (Stripe customer potentiel). Supprimer un user avec Tenant
 * = corruption multi-table, pas un "nettoyage".
 *
 * Subtilité d'archi : `User.id` (cuid string) et `Tenant.userId` (uuid)
 * ne sont PAS liés directement côté Prisma — la corrélation se fait via
 * `User.supabaseUserId` (legacy bridge UUID). On doit donc faire une
 * query séparée sur Tenant et filtrer en mémoire. Pour un volume raisonnable
 * (< 10k tenants) c'est négligeable ; pour scaler, ajouter un index sur
 * `hub_app.tenants.user_id` (déjà présent via @@index Prisma).
 *
 * Cette fonction NE FAIT QUE de la lecture. Le delete est explicitement
 * laissé à un opérateur humain, après revue des résultats. Voir le ticket
 * `todo/done/2026-05-20-prisma-prevent-orphan-users-cleanup.md` pour la
 * justification (RGPD + politique de rétention pas encore figée).
 */

import type { PrismaClient } from '@prisma/client';

export type OrphanUser = {
  id: string;
  email: string;
  createdAt: Date;
  ageDays: number;
};

export type OrphanScanResult = {
  scannedAt: string;
  minAgeDays: number;
  totalOrphans: number;
  orphans: OrphanUser[];
};

export async function findOrphanUsers(
  prisma: PrismaClient,
  options: { minAgeDays?: number; limit?: number } = {}
): Promise<OrphanScanResult> {
  const minAgeDays = options.minAgeDays ?? 7;
  const limit = options.limit ?? 1000;
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

  // Étape 1 : users sans accounts/sessions/mfaCodes ET assez vieux
  const candidates = await prisma.user.findMany({
    where: {
      createdAt: { lt: cutoff },
      accounts: { none: {} },
      sessions: { none: {} },
      mfaCodes: { none: {} },
    },
    select: {
      id: true,
      email: true,
      createdAt: true,
      supabaseUserId: true,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  if (candidates.length === 0) {
    return {
      scannedAt: new Date().toISOString(),
      minAgeDays,
      totalOrphans: 0,
      orphans: [],
    };
  }

  // Étape 2 : exclure ceux qui ont un Tenant (via supabaseUserId UUID bridge).
  // Les users sans supabaseUserId ne peuvent PAS avoir de tenant (le provisioning
  // utilise toujours supabaseUserId comme user_id), donc on les garde direct.
  const uuidsToCheck = candidates
    .map((u) => u.supabaseUserId)
    .filter((u): u is string => !!u);

  let userIdsWithTenant = new Set<string>();
  if (uuidsToCheck.length > 0) {
    const tenants = await prisma.tenant.findMany({
      where: { userId: { in: uuidsToCheck } },
      select: { userId: true },
    });
    userIdsWithTenant = new Set(tenants.map((t) => t.userId));
  }

  const now = Date.now();
  const orphans: OrphanUser[] = candidates
    .filter((u) => !u.supabaseUserId || !userIdsWithTenant.has(u.supabaseUserId))
    .map((u) => ({
      id: u.id,
      email: u.email,
      createdAt: u.createdAt,
      ageDays: Math.floor((now - u.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));

  return {
    scannedAt: new Date().toISOString(),
    minAgeDays,
    totalOrphans: orphans.length,
    orphans,
  };
}
