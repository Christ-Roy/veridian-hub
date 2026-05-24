/**
 * MEGA fixture — `downstream-db.ts`
 *
 * Helpers SQL pour interroger les DBs downstream (Notifuse staging,
 * Prospection staging) via SSH dev-pub + docker exec psql.
 *
 * **POURQUOI** : les buckets C (billing), G (cross-app sync), H
 * (invitations) doivent valider que la propagation Hub → app fonctionne
 * bout-en-bout. Ex : "après checkout Stripe Pro, le tenant côté Notifuse
 * doit avoir `veridian_plan='pro'`".
 *
 * **PRÉ-REQUIS** :
 *   - SSH alias `dev-pub` configuré + clé chargée
 *   - containers `notifuse-staging-db` et `prospection-staging-db` running
 *
 * **NAMING CONVENTION DOCKER** :
 *   - Notifuse staging DB container : `notifuse-staging-db`
 *   - Prospection staging DB container : `prospection-staging-db`
 *   - DB names : `notifuse` / `prospection` (par convention staging)
 *   - DB users : `notifuse` / `prospection` (par convention staging)
 *
 * Si une convention change côté staging, override via ENV :
 *   - `E2E_NOTIFUSE_DB_CONTAINER`, `E2E_NOTIFUSE_DB_USER`, `E2E_NOTIFUSE_DB_NAME`
 *   - `E2E_PROSPECTION_DB_CONTAINER`, `E2E_PROSPECTION_DB_USER`, `E2E_PROSPECTION_DB_NAME`
 *
 * **DELIVERY** : pour les specs G-02 (discovery by-email), les tables côté
 * Notifuse / Prospection ne sont pas encore stables. Les helpers retournent
 * `null` si la table n'existe pas, plutôt que de throw — laisse au spec
 * le choix de skip ou fail explicitement.
 */
import { execSync } from 'node:child_process';

const SSH_HOST = process.env.E2E_SSH_HOST || 'dev-pub';

const NOTIFUSE = {
  container: process.env.E2E_NOTIFUSE_DB_CONTAINER || 'notifuse-staging-db',
  user: process.env.E2E_NOTIFUSE_DB_USER || 'notifuse',
  database: process.env.E2E_NOTIFUSE_DB_NAME || 'notifuse',
};

const PROSPECTION = {
  container: process.env.E2E_PROSPECTION_DB_CONTAINER || 'prospection-staging-db',
  user: process.env.E2E_PROSPECTION_DB_USER || 'prospection',
  database: process.env.E2E_PROSPECTION_DB_NAME || 'prospection',
};

/**
 * Exécute du SQL sur une DB downstream via SSH + docker exec psql.
 * Retourne la sortie psql (vide pour DML, sinon rows en mode -tA).
 *
 * Throw une erreur typée si SSH/Docker/Postgres fail.
 */
function runDownstreamSql(
  app: 'notifuse' | 'prospection',
  sql: string,
): string {
  const cfg = app === 'notifuse' ? NOTIFUSE : PROSPECTION;
  const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=10 ${SSH_HOST} 'docker exec -i ${cfg.container} psql -U ${cfg.user} -d ${cfg.database} -tA -v ON_ERROR_STOP=1'`;
  try {
    const out = execSync(cmd, {
      input: sql,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = e.stderr?.toString() ?? '';
    const stdout = e.stdout?.toString() ?? '';
    let kind = 'Connection';
    if (/ERROR:|FATAL:|DETAIL:/.test(stderr)) {
      kind = 'PostgreSQL';
    } else if (/Permission denied|Could not resolve hostname|Connection refused|ssh:/i.test(stderr)) {
      kind = 'SSH';
    } else if (/No such container|is not running|Error response from daemon/i.test(stderr)) {
      kind = 'Docker';
    }
    throw new Error(
      `[mega/downstream-db ${app}] [${kind}] SQL failed on ${SSH_HOST}:${cfg.container}\n` +
        `SQL: ${sql.slice(0, 200)}${sql.length > 200 ? '…' : ''}\n` +
        `STDERR: ${stderr}\n` +
        `STDOUT: ${stdout}\n` +
        `MSG: ${e.message ?? 'unknown'}`,
    );
  }
}

/**
 * Vérifie qu'une table existe dans la DB downstream. Retourne `true`
 * si la table est trouvée, `false` sinon. Utile pour skipper des tests
 * G-02 tant que le schéma n'est pas livré.
 */
function tableExists(
  app: 'notifuse' | 'prospection',
  schema: string,
  table: string,
): boolean {
  // Whitelist alphanumeric + underscore pour éviter SQL injection (le
  // helper n'est pas exposé en prod mais bonne hygiène).
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema) || !/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`[mega/downstream-db] schema/table noms non-safe: ${schema}.${table}`);
  }
  try {
    const out = runDownstreamSql(
      app,
      `SELECT to_regclass('${schema}.${table}') IS NOT NULL;`,
    );
    return out.trim() === 't';
  } catch {
    return false;
  }
}

// ─── Notifuse helpers ────────────────────────────────────────────────────

/**
 * Lit le `veridian_plan` d'un workspace Notifuse par tenantId Hub.
 * Retourne `null` si pas trouvé.
 *
 * Le schéma Notifuse a une table `workspaces` avec une colonne
 * `veridian_plan` (string). Mapping tenantId Hub → workspace_id Notifuse
 * se fait via `metadata->>'hub_tenant_id'` ou directement `id =
 * tenant_id` selon conventions.
 */
export interface NotifuseWorkspaceInfo {
  id: string;
  veridian_plan: string | null;
  last_hub_sync_at: string | null;
}

export function getNotifuseWorkspace(tenantId: string): NotifuseWorkspaceInfo | null {
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantId)) {
    throw new Error(`[mega/downstream-db] unsafe tenantId: ${tenantId}`);
  }

  if (!tableExists('notifuse', 'public', 'workspaces')) {

    console.warn(
      `[mega/downstream-db] table public.workspaces absente côté Notifuse staging — helper retourne null`,
    );
    return null;
  }

  try {
    // Stratégie de lookup : on essaie d'abord id = tenantId (convention
    // Hub : tenantId = workspace.id côté downstream), sinon fallback
    // sur metadata->>'hub_tenant_id'.
    const out = runDownstreamSql(
      'notifuse',
      `SELECT id, COALESCE(veridian_plan, ''), COALESCE(last_hub_sync_at::text, '')
       FROM public.workspaces
       WHERE id = '${tenantId}'
       LIMIT 1;`,
    );
    if (!out) return null;
    const [id, plan, sync] = out.split('|');
    return {
      id,
      veridian_plan: plan || null,
      last_hub_sync_at: sync || null,
    };
  } catch (err) {

    console.warn(
      `[mega/downstream-db] getNotifuseWorkspace failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Purge les workspaces/users Notifuse matching le préfixe MEGA.
 * Idempotent. Try/catch interne (no throw, log only).
 */
export function purgeNotifuseMega(): { workspacesDeleted: number; usersDeleted: number } {
  if (!tableExists('notifuse', 'public', 'workspaces')) {
    return { workspacesDeleted: 0, usersDeleted: 0 };
  }

  try {
    const out = runDownstreamSql(
      'notifuse',
      `
      WITH
        del_ws AS (
          DELETE FROM public.workspaces
          WHERE id LIKE 'mega-%'
          RETURNING 1
        ),
        del_users AS (
          DELETE FROM public.users
          WHERE email LIKE 'e2e-mega-%'
          RETURNING 1
        )
      SELECT
        (SELECT count(*) FROM del_ws) AS workspaces,
        (SELECT count(*) FROM del_users) AS users
      ;
      `,
    );
    const [ws, users] = (out.split('\n')[0] ?? '').split('|');
    return {
      workspacesDeleted: Number(ws) || 0,
      usersDeleted: Number(users) || 0,
    };
  } catch (err) {

    console.warn(
      `[mega/downstream-db] purgeNotifuseMega failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { workspacesDeleted: 0, usersDeleted: 0 };
  }
}

// ─── Prospection helpers ─────────────────────────────────────────────────

export interface ProspectionWorkspaceInfo {
  id: string;
  veridian_plan: string | null;
  leads_balance: number | null;
  last_hub_sync_at: string | null;
}

export function getProspectionWorkspace(
  tenantId: string,
): ProspectionWorkspaceInfo | null {
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantId)) {
    throw new Error(`[mega/downstream-db] unsafe tenantId: ${tenantId}`);
  }

  // Tables possibles : `workspaces` ou `tenants` selon convention Prospection.
  // On tente `workspaces` d'abord.
  const tableName = tableExists('prospection', 'public', 'workspaces')
    ? 'workspaces'
    : tableExists('prospection', 'public', 'tenants')
      ? 'tenants'
      : null;
  if (!tableName) {

    console.warn(
      `[mega/downstream-db] ni workspaces ni tenants n'existent côté Prospection staging`,
    );
    return null;
  }

  try {
    const out = runDownstreamSql(
      'prospection',
      `SELECT id::text,
              COALESCE(veridian_plan, ''),
              COALESCE(leads_balance::text, '0'),
              COALESCE(last_hub_sync_at::text, '')
       FROM public.${tableName}
       WHERE id::text = '${tenantId}' OR (
         CASE WHEN '${tableName}' = 'tenants' THEN tenant_id = '${tenantId}' ELSE false END
       )
       LIMIT 1;`,
    );
    if (!out) return null;
    const [id, plan, leads, sync] = out.split('|');
    return {
      id,
      veridian_plan: plan || null,
      leads_balance: leads ? Number(leads) : null,
      last_hub_sync_at: sync || null,
    };
  } catch (err) {

    console.warn(
      `[mega/downstream-db] getProspectionWorkspace failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

export function purgeProspectionMega(): { workspacesDeleted: number; usersDeleted: number } {
  const wsTable = tableExists('prospection', 'public', 'workspaces')
    ? 'workspaces'
    : tableExists('prospection', 'public', 'tenants')
      ? 'tenants'
      : null;
  if (!wsTable) {
    return { workspacesDeleted: 0, usersDeleted: 0 };
  }

  try {
    const out = runDownstreamSql(
      'prospection',
      `
      WITH
        del_ws AS (
          DELETE FROM public.${wsTable}
          WHERE ${wsTable === 'tenants' ? 'tenant_id' : 'id::text'} LIKE 'mega-%'
          RETURNING 1
        ),
        del_users AS (
          DELETE FROM public.users
          WHERE email LIKE 'e2e-mega-%'
          RETURNING 1
        )
      SELECT
        (SELECT count(*) FROM del_ws) AS workspaces,
        (SELECT count(*) FROM del_users) AS users
      ;
      `,
    );
    const [ws, users] = (out.split('\n')[0] ?? '').split('|');
    return {
      workspacesDeleted: Number(ws) || 0,
      usersDeleted: Number(users) || 0,
    };
  } catch (err) {

    console.warn(
      `[mega/downstream-db] purgeProspectionMega failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { workspacesDeleted: 0, usersDeleted: 0 };
  }
}

/**
 * Test de connectivité de base. Utilisé par `mega-precheck.sh`.
 * Retourne `true` si ssh + docker exec + psql répondent dans les temps.
 */
export function pingDownstream(app: 'notifuse' | 'prospection'): boolean {
  try {
    const out = runDownstreamSql(app, 'SELECT 1;');
    return out.trim() === '1';
  } catch {
    return false;
  }
}
