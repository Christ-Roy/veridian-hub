/**
 * Agrégation des apps actives pour un email (réponse `/api/users/by-email`).
 *
 * Source de vérité côté Hub à l'instant T :
 *   - `hub_app.users` : pivot par email (lookup unique). Si l'user n'existe
 *      pas → `{exists: false, tenants: []}`. Pas de leak (pas de
 *      différenciation 401 vs 404 côté caller, juste un payload minimal).
 *   - `hub_app.tenants` (legacy provisioning Notifuse + Prospection) :
 *      un row par tenant. La table garde des colonnes dénormalisées
 *      `notifuse_*` et `prospection_*`. Présence d'un slug/api key →
 *      l'app est attachée à ce tenant pour cet user-owner. Rôle = `owner`
 *      car `tenants.user_id` = créateur initial.
 *   - `hub_app.tenant_members` (cross-app §11bis) : memberships secondaires
 *      (un user invité dans un workspace d'un autre owner). On rejoint
 *      sur `tenant.id` puis on déduit `app` via les colonnes
 *      `notifuse_*`/`prospection_*` du tenant joint. `role` = celui stocké
 *      sur la row member (default `member`).
 *
 * Réponse minimaliste **par design** (privacy) :
 *   `{ exists: boolean, tenants: [{ app: SupportedApp, role: string }] }`
 *
 *   - PAS de noms d'autres users
 *   - PAS d'emails autres que celui demandé
 *   - PAS de workspace_id (qui pourrait être énuméré)
 *   - PAS de plan / billing state (autre endpoint pour ça)
 *
 * Hub = source de vérité pour l'EXISTENCE d'un lien user↔app, pas pour le
 * détail. Les apps qui veulent plus (workspace_id, plan) doivent ensuite
 * appeler leurs propres endpoints — c'est le pattern "discovery" du
 * ticket `2026-05-20-hub-discovery-by-email-pattern.md`.
 *
 * Cache : pas de cache ici. C'est appelé au login uniquement (path froid),
 * le bénéfice marginal d'un cache 5 min vs le risque de stale (un user
 * qui vient d'être ajouté à un workspace ne se voit pas immédiatement)
 * ne vaut pas le coût d'invalidation. À ajouter en Phase 2 si volume
 * exigeant — voir l'évolution future dans le ticket source.
 */

import type { PrismaClient } from '@prisma/client';
import type { SupportedApp } from './hmac';

export type DiscoveryTenant = {
  app: SupportedApp;
  role: string;
};

export type DiscoveryResult = {
  exists: boolean;
  tenants: DiscoveryTenant[];
};

/**
 * Helper interne : ajoute un tenant dans la liste si pas déjà présent
 * pour la même (app, role). Préserve la première occurrence (priorité
 * owner > member car owner est inséré en premier dans le flow).
 */
function pushUnique(
  list: DiscoveryTenant[],
  app: SupportedApp,
  role: string,
): void {
  // Si déjà présent avec rôle owner, on ne dégrade pas en member.
  if (list.some((t) => t.app === app && t.role === 'owner')) return;
  // Si déjà présent avec le même rôle, no-op.
  if (list.some((t) => t.app === app && t.role === role)) return;
  // Si owner arrive après un member sur la même app, on remplace member
  // par owner (owner gagne).
  if (role === 'owner') {
    const idx = list.findIndex((t) => t.app === app);
    if (idx >= 0) {
      list[idx] = { app, role };
      return;
    }
  }
  list.push({ app, role });
}

/**
 * Inspecte une row Tenant et pousse les apps détectées dans la liste.
 *
 * Détection :
 *   - `notifuseWorkspaceSlug` non null → app `notifuse` attachée
 *   - `prospectionApiKey` non null → app `prospection` attachée
 *
 * Les apps `analytics` et `cms` ne sont pas dénormalisées dans la table
 * `tenants` aujourd'hui (cf. ticket discovery, §"Aujourd'hui ça ne
 * marche pas"). Le Hub ne peut pas les attester par ce chemin — il faut
 * attendre soit une migration `cms_*`/`analytics_*` soit un TenantMember
 * dédié. Pour l'instant, on les omet (résultat partiel, jamais faux).
 */
function appsFromTenantRow(
  tenant: { notifuseWorkspaceSlug: string | null; prospectionApiKey: string | null },
): SupportedApp[] {
  const apps: SupportedApp[] = [];
  if (tenant.notifuseWorkspaceSlug) apps.push('notifuse');
  if (tenant.prospectionApiKey) apps.push('prospection');
  return apps;
}

/**
 * Agrège les apps connues côté Hub pour un email donné.
 *
 * Algo :
 *   1. Lookup `users.email = email` (insensible casse via lowercase préalable).
 *   2. Si pas de user → `{exists: false, tenants: []}`.
 *   3. Si user n'a pas de `supabaseUserId` (cas pathologique pré-bridge
 *      OAuth) → on retourne `{exists: true, tenants: []}` : l'user existe
 *      bien côté Hub mais on ne peut pas joindre les tenants. C'est volontaire
 *      pour ne pas masquer un état dégradé.
 *   4. Trouve les `tenants` où `userId = supabaseUserId` (owner) → push owner.
 *   5. Trouve les `tenant_members` où `userId = supabaseUserId` ET `deletedAt`
 *      null → push role membre du membership.
 *   6. Dédup avec règle owner > member.
 *
 * On reste sur des requêtes simples (pas de raw SQL) pour la lisibilité
 * et la portabilité tests. Volume attendu : 1 user logue → quelques tenants
 * max → pas un hot path à optimiser.
 */
export async function discoverAppsByEmail(
  prisma: PrismaClient,
  email: string,
): Promise<DiscoveryResult> {
  // Normalisation email : lookup case-insensitive. `findUnique` Prisma est
  // case-sensitive par défaut sur Postgres, donc on lowercase l'input et on
  // suppose que `users.email` est stocké lowercased (convention signup +
  // Auth.js). Si un user historique a un email mixte, on retombe sur
  // findFirst case-insensitive en fallback.
  const lowered = email.toLowerCase();
  let user = await prisma.user.findUnique({
    where: { email: lowered },
    select: { id: true, supabaseUserId: true },
  });

  if (!user) {
    // Fallback case-insensitive pour les emails historiques en CamelCase.
    // Coût acceptable car n'arrive qu'en cache miss + email pas en lowercase.
    user = await prisma.user.findFirst({
      where: { email: { equals: lowered, mode: 'insensitive' } },
      select: { id: true, supabaseUserId: true },
    });
  }

  if (!user) {
    return { exists: false, tenants: [] };
  }

  // User existe mais pas de bridge supabase → on remonte l'existence sans
  // pouvoir joindre les tenants. L'agent admin doit fixer le user (cf.
  // `reference_oauth_supabase_user_id_bridge.md`).
  if (!user.supabaseUserId) {
    return { exists: true, tenants: [] };
  }

  const tenantsOwned = await prisma.tenant.findMany({
    where: {
      userId: user.supabaseUserId,
      deletedAt: null,
    },
    select: {
      id: true,
      notifuseWorkspaceSlug: true,
      prospectionApiKey: true,
    },
  });

  const memberRows = await prisma.tenantMember.findMany({
    where: {
      userId: user.supabaseUserId,
      deletedAt: null,
    },
    select: {
      tenantId: true,
      role: true,
    },
  });

  const result: DiscoveryTenant[] = [];

  // Owner : push toutes les apps détectées sur les tenants possédés.
  for (const t of tenantsOwned) {
    for (const app of appsFromTenantRow(t)) {
      pushUnique(result, app, 'owner');
    }
  }

  // Member : nécessite de charger les rows tenant correspondantes pour
  // savoir quelles apps sont attachées. On filtre les tenants déjà chargés
  // (owner) pour économiser une requête.
  const ownedIds = new Set(tenantsOwned.map((t) => t.id));
  const memberTenantIds = memberRows
    .map((m) => m.tenantId)
    .filter((id) => !ownedIds.has(id));

  if (memberTenantIds.length > 0) {
    const memberTenants = await prisma.tenant.findMany({
      where: {
        id: { in: memberTenantIds },
        deletedAt: null,
      },
      select: {
        id: true,
        notifuseWorkspaceSlug: true,
        prospectionApiKey: true,
      },
    });
    const byId = new Map(memberTenants.map((t) => [t.id, t]));
    for (const m of memberRows) {
      const t = byId.get(m.tenantId);
      if (!t) continue;
      for (const app of appsFromTenantRow(t)) {
        pushUnique(result, app, m.role);
      }
    }
  }

  return { exists: true, tenants: result };
}
