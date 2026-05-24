/**
 * MEGA fixture — `db-purge.ts`
 *
 * Purge des artifacts DB Hub créés par la suite MEGA. Filtre strict par
 * préfixe `e2e-mega-*` pour les emails et `mega-*` pour les tenants —
 * zéro risque de supprimer un user/tenant réel.
 *
 * **POURQUOI** : chaque spec MEGA crée 1+ user + 1+ tenant. Sans cleanup,
 * la DB staging gonfle vite (1 run MEGA = ~50 tenants test). En 100 runs,
 * on a 5000 rows zombie qui faussent les requêtes admin et ralentissent
 * les listings.
 *
 * **STRATÉGIE** :
 *   1. `purgeMegaByPrefix(prefix)` — purge tous les artifacts matching
 *      un préfixe précis (ex: `mega-A-12345-`). Appelé par
 *      `test.afterAll` de chaque spec, scope étroit.
 *   2. `purgeAllMegaArtifacts()` — purge TOUS les artifacts `e2e-mega-%`
 *      peu importe le run_stamp. Appelé par `globalTeardown` + script
 *      `mega-purge.sh` humain.
 *
 * **ORDRE DES DELETE** (FK cascade respecté) :
 *   1. `tenant_trials` (FK tenant_id)
 *   2. `subscriptions` (FK user_id)
 *   3. `stripe_events` (FK customer_id → user.stripe_customer_id)
 *   4. `audit_log` (par tenant_id ou actor)
 *   5. `invitations` (FK workspace_id, expires)
 *   6. `tenant_members` (FK tenant_id, user_id)
 *   7. `tenants` (FK user_id)
 *   8. `workspace_members` (FK workspace_id, user_id)
 *   9. `workspaces` (FK owner_id)
 *   10. `accounts` (FK userId)
 *   11. `sessions` (FK userId)
 *   12. `oauth_sign_in_events` (par email)
 *   13. `users` (root)
 *
 * **PERFORMANCE** : 1 batch SQL = 1 SSH roundtrip ≈ 700ms. On regroupe
 * tous les DELETE en un seul script multi-statement pour minimiser.
 *
 * **SÉCURITÉ** :
 *   - Refus si prefix vide ou ne commence pas par `mega-` / `e2e-mega-`
 *   - Validation regex stricte (alphanumeric + dash uniquement)
 */
import { runSqlOnStaging } from '../../_sql-helper';

import { MEGA_EMAIL_PREFIX, MEGA_TENANT_PREFIX } from './run-stamp';

/**
 * Statistiques retournées par chaque purge (utile pour log/audit).
 */
export interface PurgeStats {
  emailPrefix: string;
  tenantPrefix: string;
  rowsDeleted: Record<string, number>;
  durationMs: number;
}

/**
 * Garde-fou : refuse tout préfixe qui ne respecte pas la regex MEGA.
 * Anti-régression : si on appelle `purgeMegaByPrefix('')` ou
 * `purgeMegaByPrefix('user')`, on wipe la DB — REFUS strict.
 */
function assertSafeEmailPrefix(prefix: string): void {
  if (!prefix.startsWith(MEGA_EMAIL_PREFIX)) {
    throw new Error(
      `[mega/db-purge] email prefix '${prefix}' doit commencer par '${MEGA_EMAIL_PREFIX}' (refus anti-wipe DB)`,
    );
  }
  // Accepte 'e2e-mega-' (préfixe nu pour purge globale) OU 'e2e-mega-<suffix>'
  // avec suffix alphanumeric + dash. Refuse chars dangereux ('%', "'", ' ', etc.)
  if (!/^e2e-mega-[a-z0-9-]*$/.test(prefix)) {
    throw new Error(
      `[mega/db-purge] email prefix '${prefix}' contient des chars invalides (autorisé : [a-z0-9-])`,
    );
  }
}

function assertSafeTenantPrefix(prefix: string): void {
  if (!prefix.startsWith(MEGA_TENANT_PREFIX)) {
    throw new Error(
      `[mega/db-purge] tenant prefix '${prefix}' doit commencer par '${MEGA_TENANT_PREFIX}' (refus anti-wipe DB)`,
    );
  }
  if (!/^mega-[a-z0-9-]*$/.test(prefix)) {
    throw new Error(
      `[mega/db-purge] tenant prefix '${prefix}' contient des chars invalides (autorisé : [a-z0-9-])`,
    );
  }
}

/**
 * Purge ciblée par préfixe précis. Utilisé par `test.afterAll` de
 * chaque spec (scope étroit = pas de collision avec specs voisins).
 *
 * @param opts.emailPrefix ex: `e2e-mega-a-01-1716566612345-x9k2`
 * @param opts.tenantPrefix ex: `mega-a-1716566612345-x9k2`
 */
export async function purgeMegaByPrefix(opts: {
  emailPrefix: string;
  tenantPrefix: string;
}): Promise<PurgeStats> {
  assertSafeEmailPrefix(opts.emailPrefix);
  assertSafeTenantPrefix(opts.tenantPrefix);

  const start = Date.now();
  const emailPattern = `${opts.emailPrefix}%`;
  const tenantPattern = `${opts.tenantPrefix}%`;

  // Script SQL multi-statement. Tous les DELETE sont idempotents
  // (DELETE FROM X WHERE Y → 0 rows si rien à supprimer).
  //
  // CAST UUID/TEXT : Hub a 2 identifiants par user :
  //   - users.id (String cuid, FK pour Account, Session, Workspace.ownerId,
  //     WorkspaceMember.userId, Subscription via legacy ?)
  //   - users.supabase_user_id (UUID, FK pour Tenant.user_id, Subscription.user_id,
  //     TenantMember.user_id — le "UUID bridge" cross-app)
  //
  // → Pour les FK UUID (subscriptions, tenants, tenant_members) on lookup via
  //   supabase_user_id::uuid. Pour les FK String/cuid (accounts, sessions,
  //   workspaces, workspace_members, invitations) on lookup via users.id.
  //
  // Note : on évite les CASCADE Postgres car les FK Hub ne sont pas toutes
  // en ON DELETE CASCADE (auditabilité). On ordonne explicitement.
  const sql = `
    WITH
      del_trials AS (
        DELETE FROM hub_app.tenant_trials
        WHERE tenant_id LIKE '${tenantPattern}'
        RETURNING 1
      ),
      del_subs AS (
        DELETE FROM hub_app.subscriptions
        WHERE user_id IN (
          SELECT supabase_user_id::uuid FROM hub_app.users
          WHERE email LIKE '${emailPattern}' AND supabase_user_id IS NOT NULL
        )
        RETURNING 1
      ),
      del_stripe_evts AS (
        DELETE FROM hub_app.stripe_events
        WHERE customer_id IN (
          SELECT stripe_customer_id FROM hub_app.users
          WHERE email LIKE '${emailPattern}' AND stripe_customer_id IS NOT NULL
        )
        RETURNING 1
      ),
      del_audit AS (
        DELETE FROM hub_app.audit_log
        WHERE target_id LIKE '${tenantPattern}'
           OR actor LIKE '%${emailPattern}%'
        RETURNING 1
      ),
      del_invitations AS (
        DELETE FROM hub_app.invitations
        WHERE workspace_id IN (
          SELECT id FROM hub_app.workspaces WHERE owner_id IN (
            SELECT id FROM hub_app.users WHERE email LIKE '${emailPattern}'
          )
        )
        RETURNING 1
      ),
      del_tenant_members AS (
        DELETE FROM hub_app.tenant_members
        WHERE user_id IN (
          SELECT supabase_user_id FROM hub_app.users
          WHERE email LIKE '${emailPattern}' AND supabase_user_id IS NOT NULL
        )
           OR tenant_id IN (
             SELECT id::text FROM hub_app.tenants WHERE slug LIKE '${tenantPattern}'
           )
        RETURNING 1
      ),
      del_tenants AS (
        DELETE FROM hub_app.tenants
        WHERE slug LIKE '${tenantPattern}'
           OR user_id IN (
             SELECT supabase_user_id::uuid FROM hub_app.users
             WHERE email LIKE '${emailPattern}' AND supabase_user_id IS NOT NULL
           )
        RETURNING 1
      ),
      del_ws_members AS (
        DELETE FROM hub_app.workspace_members
        WHERE user_id IN (
          SELECT id FROM hub_app.users WHERE email LIKE '${emailPattern}'
        )
        RETURNING 1
      ),
      del_workspaces AS (
        DELETE FROM hub_app.workspaces
        WHERE owner_id IN (
          SELECT id FROM hub_app.users WHERE email LIKE '${emailPattern}'
        )
        RETURNING 1
      ),
      del_accounts AS (
        DELETE FROM hub_app.accounts
        WHERE user_id IN (
          SELECT id FROM hub_app.users WHERE email LIKE '${emailPattern}'
        )
        RETURNING 1
      ),
      del_sessions AS (
        DELETE FROM hub_app.sessions
        WHERE user_id IN (
          SELECT id FROM hub_app.users WHERE email LIKE '${emailPattern}'
        )
        RETURNING 1
      ),
      del_users AS (
        DELETE FROM hub_app.users
        WHERE email LIKE '${emailPattern}'
        RETURNING 1
      )
    SELECT
      (SELECT count(*) FROM del_trials)         AS trials,
      (SELECT count(*) FROM del_subs)           AS subs,
      (SELECT count(*) FROM del_stripe_evts)    AS stripe_evts,
      (SELECT count(*) FROM del_audit)          AS audit,
      (SELECT count(*) FROM del_invitations)    AS invitations,
      (SELECT count(*) FROM del_tenant_members) AS tenant_members,
      (SELECT count(*) FROM del_tenants)        AS tenants,
      (SELECT count(*) FROM del_ws_members)     AS ws_members,
      (SELECT count(*) FROM del_workspaces)     AS workspaces,
      (SELECT count(*) FROM del_accounts)       AS accounts,
      (SELECT count(*) FROM del_sessions)       AS sessions,
      (SELECT count(*) FROM del_users)          AS users
    ;
  `;

  let out: string;
  try {
    out = runSqlOnStaging(sql);
  } catch (err) {
    // En cleanup, on ne fail JAMAIS. Mieux vaut un reliquat manuel à
    // purger qu'un test qui throw dans afterEach et bypass tous les
    // cleanups suivants. On log et on retourne 0 partout.

    console.warn(
      `[mega/db-purge] SQL purge failed for ${opts.emailPrefix}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      emailPrefix: opts.emailPrefix,
      tenantPrefix: opts.tenantPrefix,
      rowsDeleted: {},
      durationMs: Date.now() - start,
    };
  }

  // Parser ligne `12|3|0|45|...` du psql -tA
  const values = (out.split('\n')[0] ?? '').split('|');
  const columns = [
    'trials',
    'subs',
    'stripe_evts',
    'audit',
    'invitations',
    'tenant_members',
    'tenants',
    'ws_members',
    'workspaces',
    'accounts',
    'sessions',
    'users',
  ];
  const rowsDeleted: Record<string, number> = {};
  for (let i = 0; i < columns.length; i++) {
    rowsDeleted[columns[i]] = Number(values[i] ?? '0') || 0;
  }

  return {
    emailPrefix: opts.emailPrefix,
    tenantPrefix: opts.tenantPrefix,
    rowsDeleted,
    durationMs: Date.now() - start,
  };
}

/**
 * Purge globale de TOUS les artifacts MEGA. Peu importe le `run_stamp`.
 *
 * Appelé par :
 *   - `globalTeardown` à la fin de chaque run MEGA
 *   - script `mega-purge.sh` humain (filet de secours)
 *
 * Préfixes :
 *   - emails : `e2e-mega-%@e2e.veridian.site`
 *   - tenants : `mega-%`
 */
export async function purgeAllMegaArtifacts(): Promise<PurgeStats> {
  return purgeMegaByPrefix({
    emailPrefix: 'e2e-mega-',
    tenantPrefix: 'mega-',
  });
}

/**
 * Vérification post-purge : compte combien de rows MEGA restent
 * (devrait être 0). À appeler en fin de `globalTeardown` pour valider
 * que le cleanup a bien tout pris.
 *
 * Retourne `{ users, tenants, workspaces, ... }`. Si une valeur > 0 →
 * un cleanup a failed quelque part → log warning.
 */
export interface MegaResiduesCheck {
  users: number;
  tenants: number;
  workspaces: number;
  tenantTrials: number;
  total: number;
}

export async function countMegaResidues(): Promise<MegaResiduesCheck> {
  const sql = `
    SELECT
      (SELECT count(*) FROM hub_app.users WHERE email LIKE 'e2e-mega-%')          AS users,
      (SELECT count(*) FROM hub_app.tenants WHERE slug LIKE 'mega-%')             AS tenants,
      (SELECT count(*) FROM hub_app.workspaces WHERE owner_id IN (
        SELECT id FROM hub_app.users WHERE email LIKE 'e2e-mega-%'
      ))                                                                          AS workspaces,
      (SELECT count(*) FROM hub_app.tenant_trials WHERE tenant_id LIKE 'mega-%')  AS tenant_trials
    ;
  `;

  let out: string;
  try {
    out = runSqlOnStaging(sql);
  } catch (err) {

    console.warn(
      `[mega/db-purge] residues check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { users: -1, tenants: -1, workspaces: -1, tenantTrials: -1, total: -1 };
  }

  const values = (out.split('\n')[0] ?? '').split('|');
  const users = Number(values[0] ?? '0') || 0;
  const tenants = Number(values[1] ?? '0') || 0;
  const workspaces = Number(values[2] ?? '0') || 0;
  const tenantTrials = Number(values[3] ?? '0') || 0;
  return {
    users,
    tenants,
    workspaces,
    tenantTrials,
    total: users + tenants + workspaces + tenantTrials,
  };
}
