/**
 * Helper SSH/SQL pour les specs E2E qui ont besoin de manipuler directement
 * la DB staging — typiquement pour simuler le temps (back-date un eligible_at
 * de -49h pour déclencher l'activation cron sans attendre 48h réelles).
 *
 * **POURQUOI** : la trial state machine est temporelle (48h éligible →
 * activation, 12j → ending soon, 15j → finalize). Sans manipulation directe
 * des timestamps en DB, impossible de tester le cron tick en moins de 15
 * jours. C'est le pattern industriel standard (cf. Stripe billing CLI
 * `stripe trigger`, qui fait exactement pareil côté Stripe sandbox).
 *
 * **SÉCURITÉ** : on n'expose JAMAIS ce helper en prod. Le fichier n'est
 * importable que depuis `e2e/staging-full/**` qui ne tourne que sur
 * staging via `pnpm e2e:staging:full`. Les CI prod (e2e-prod-smoke)
 * n'ont accès qu'à `e2e/prod-smoke/` qui n'importe pas ce fichier.
 *
 * **PRÉ-REQUIS** :
 *   - SSH alias `dev-pub` configuré + clé chargée (cf
 *     `~/.ssh/config` et CLAUDE.md racine)
 *   - container `hub-staging-db` accessible en docker exec sur dev-pub
 *
 * **PERFORMANCE** : chaque appel ≈ 700ms (SSH handshake + psql exec).
 * Utiliser avec parcimonie. Pour les batches, préférer un seul appel multi-
 * statements via `runSqlOnStaging` plutôt que N appels séparés.
 */
import { execSync } from 'node:child_process';

const SSH_HOST = process.env.E2E_SSH_HOST || 'dev-pub';
const DB_CONTAINER = process.env.E2E_DB_CONTAINER || 'hub-staging-db';
const DB_USER = process.env.E2E_DB_USER || 'hub';
const DB_NAME = process.env.E2E_DB_NAME || 'hub';

/**
 * Exécute une requête SQL sur la DB staging Hub via SSH+docker exec.
 *
 * @param sql - une ou plusieurs instructions SQL. Échapper les single quotes
 *              en doublant (`''`). Échapper les `$` shell si le SQL contient
 *              des dollar-quoted strings.
 * @returns la sortie psql (vide pour DDL/DML, sinon les rows en mode -tA).
 */
export function runSqlOnStaging(sql: string): string {
  // Stratégie : on pipe le SQL via stdin pour éviter les pièges de shell
  // quoting. SSH ouvre une session non-interactive, docker exec -i lit stdin.
  const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=10 ${SSH_HOST} 'docker exec -i ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -tA -v ON_ERROR_STOP=1'`;
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
    throw new Error(
      `SQL exec failed on ${SSH_HOST}:${DB_CONTAINER}\n` +
        `SQL: ${sql.slice(0, 200)}${sql.length > 200 ? '…' : ''}\n` +
        `STDERR: ${stderr}\n` +
        `STDOUT: ${stdout}\n` +
        `MSG: ${e.message ?? 'unknown'}`,
    );
  }
}

/**
 * Lit un seul scalaire (1 row, 1 colonne) depuis le SQL. Retourne `null`
 * si pas de row. Utile pour `SELECT state FROM tenant_trials WHERE ...`.
 */
export function selectScalar(sql: string): string | null {
  const out = runSqlOnStaging(sql);
  if (!out) return null;
  return out.split('\n')[0].trim();
}

/**
 * Retourne un objet { col: val } à partir d'un SELECT mono-row.
 * Le SQL doit utiliser une projection explicite et un ORDER BY si pertinent.
 *
 * Exemple :
 *   selectRow(`SELECT state, trial_started_at, trial_ends_at
 *              FROM hub_app.tenant_trials
 *              WHERE tenant_id = 'foo' AND app = 'notifuse'`)
 *   → { state: 'trial_active', trial_started_at: '2026-05-21 ...', ... }
 */
export function selectRow(sql: string, columns: string[]): Record<string, string> | null {
  const out = runSqlOnStaging(sql);
  if (!out) return null;
  const firstLine = out.split('\n')[0];
  const values = firstLine.split('|'); // -tA pipe-delimited
  if (values.length !== columns.length) {
    throw new Error(
      `selectRow: expected ${columns.length} cols (${columns.join(',')}), got ${values.length} from line "${firstLine}"`,
    );
  }
  const obj: Record<string, string> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = values[i];
  }
  return obj;
}

/**
 * Supprime une row tenant_trial (cleanup test). Idempotent (rien si row
 * absente).
 */
export function deleteTenantTrial(tenantId: string, app: string): void {
  // Échappement simple : on autorise uniquement alphanumeric + `-` `_` `.`
  // dans tenantId/app pour les tests E2E. Si l'appelant passe autre chose,
  // c'est un bug dans le test, pas un risque sécu (le helper n'est pas
  // exposé en prod).
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantId) || !/^[a-z]+$/.test(app)) {
    throw new Error(`deleteTenantTrial: unsafe identifier (tenantId=${tenantId}, app=${app})`);
  }
  runSqlOnStaging(
    `DELETE FROM hub_app.tenant_trials WHERE tenant_id = '${tenantId}' AND app = '${app}';`,
  );
}

/**
 * Met à jour eligible_at sur une row existante. Utile pour back-dater une
 * row 'eligible' à -49h afin de la faire passer en 'trial_active' au prochain
 * cron tick.
 */
export function setEligibleAt(tenantId: string, app: string, isoDate: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantId) || !/^[a-z]+$/.test(app)) {
    throw new Error(`setEligibleAt: unsafe identifier`);
  }
  runSqlOnStaging(
    `UPDATE hub_app.tenant_trials SET eligible_at = '${isoDate}' WHERE tenant_id = '${tenantId}' AND app = '${app}';`,
  );
}

/**
 * Back-date trial_started_at + trial_ends_at pour simuler que le trial a
 * démarré il y a N jours. Le caller calcule N (12 pour notifier ending-soon,
 * 16 pour finaliser, etc.).
 */
export function backdateTrialActive(
  tenantId: string,
  app: string,
  startedAtIso: string,
  endsAtIso: string,
): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantId) || !/^[a-z]+$/.test(app)) {
    throw new Error(`backdateTrialActive: unsafe identifier`);
  }
  runSqlOnStaging(
    `UPDATE hub_app.tenant_trials
     SET trial_started_at = '${startedAtIso}',
         trial_ends_at = '${endsAtIso}'
     WHERE tenant_id = '${tenantId}' AND app = '${app}';`,
  );
}
