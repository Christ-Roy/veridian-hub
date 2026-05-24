/**
 * MEGA fixture — `audit-log.ts`
 *
 * Helpers pour lire `hub_app.audit_log` et asserter qu'une action a
 * bien laissé une trace (ou qu'aucune trace résiduelle n'existe).
 *
 * **POURQUOI** : la moitié des asserts MEGA listent des entries
 * `audit_log` (ex: A-01 attend `user.signup_completed`, C-01 attend
 * `billing.checkout.completed` + `billing.subscription.activated`).
 * Factoriser le query SQL + parsing dans un helper évite 80× la même
 * boilerplate.
 *
 * **SCHÉMA** (cf. prisma/schema.prisma AuditLog) :
 *   - id (cuid)
 *   - action (string, ex: 'admin.user.create', 'billing.checkout.completed')
 *   - actor (string, ex: 'admin:robert.brunon@veridian.site', 'system:cron')
 *   - target_type (string?, ex: 'user', 'tenant', 'subscription')
 *   - target_id (string?, ex: 'mega-A-12345-fresh')
 *   - payload (jsonb?)
 *   - created_at (timestamptz, default now())
 *
 * **API** :
 *
 *   const entries = await findAuditEntries({
 *     action: 'billing.checkout.completed',
 *     targetId: 'mega-c-01-12345',
 *   });
 *   expect(entries).toHaveLength(1);
 *   expect(entries[0].payload).toMatchObject({ plan: 'notifuse-pro' });
 *
 * **PERF** : 1 query SQL = 1 SSH roundtrip ≈ 700ms. Préférer 1 query
 * groupée à N queries séparées si possible.
 */
import { runSqlOnStaging } from '../../_sql-helper';

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface FindAuditOpts {
  /** Filtre exact sur action (ex: `billing.checkout.completed`). */
  action?: string;
  /** Filtre LIKE sur action (ex: `billing.%`). */
  actionLike?: string;
  /** Filtre exact sur target_id. */
  targetId?: string;
  /** Filtre LIKE sur target_id (ex: `mega-A-12345-%`). */
  targetIdLike?: string;
  /** Filtre LIKE sur actor (ex: `%@e2e.veridian.site`). */
  actorLike?: string;
  /** Limite de résultats. Défaut 100. */
  limit?: number;
  /** Tri. Défaut `created_at DESC`. */
  orderBy?: 'created_at DESC' | 'created_at ASC';
}

/**
 * Échappe une valeur pour insertion sécurisée dans un literal SQL.
 * Whitelist alphanumeric + dash + dot + colon + at + underscore (safe pour
 * les identifiants Veridian : emails, tenant slugs, action names).
 */
function safeLiteral(value: string, allowPercent = false): string {
  const allowed = allowPercent
    ? /^[A-Za-z0-9._:@%-]+$/
    : /^[A-Za-z0-9._:@-]+$/;
  if (!allowed.test(value)) {
    throw new Error(
      `[mega/audit-log] valeur non-safe pour SQL literal: '${value}' ` +
        `(autorisé : ${allowed.toString()})`,
    );
  }
  return value;
}

/**
 * Cherche les entries `audit_log` matching les critères. Retourne un
 * array (vide si rien trouvé).
 */
export async function findAuditEntries(opts: FindAuditOpts): Promise<AuditEntry[]> {
  const where: string[] = [];

  if (opts.action) {
    where.push(`action = '${safeLiteral(opts.action)}'`);
  }
  if (opts.actionLike) {
    where.push(`action LIKE '${safeLiteral(opts.actionLike, true)}'`);
  }
  if (opts.targetId) {
    where.push(`target_id = '${safeLiteral(opts.targetId)}'`);
  }
  if (opts.targetIdLike) {
    where.push(`target_id LIKE '${safeLiteral(opts.targetIdLike, true)}'`);
  }
  if (opts.actorLike) {
    where.push(`actor LIKE '${safeLiteral(opts.actorLike, true)}'`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = opts.orderBy ?? 'created_at DESC';
  const limit = opts.limit ?? 100;

  const sql = `
    SELECT
      id,
      action,
      actor,
      COALESCE(target_type, '') AS target_type,
      COALESCE(target_id, '') AS target_id,
      COALESCE(payload::text, '') AS payload,
      created_at::text AS created_at
    FROM hub_app.audit_log
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  ;`;

  let out: string;
  try {
    out = runSqlOnStaging(sql);
  } catch (err) {

    console.warn(
      `[mega/audit-log] findAuditEntries failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  if (!out) return [];

  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [id, action, actor, targetType, targetId, payloadRaw, createdAt] =
        line.split('|');
      let payload: Record<string, unknown> | null = null;
      if (payloadRaw && payloadRaw !== '') {
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          payload = null;
        }
      }
      return {
        id,
        action,
        actor,
        targetType: targetType || null,
        targetId: targetId || null,
        payload,
        createdAt,
      };
    });
}

/**
 * Asserte qu'AU MOINS UNE entry matching les critères existe. Throw
 * avec message diagnostic si aucune trouvée.
 *
 * Le caller récupère l'entry trouvée pour asserter ses champs.
 */
export async function assertAuditEntry(opts: FindAuditOpts): Promise<AuditEntry> {
  const entries = await findAuditEntries({ ...opts, limit: 10 });
  if (entries.length === 0) {
    const criteria = JSON.stringify(opts);
    throw new Error(
      `[mega/audit-log] aucune entry trouvée pour ${criteria}. ` +
        `Vérifie que l'action est bien tracée côté Hub (lib/audit-log/ ou inline).`,
    );
  }
  return entries[0];
}

/**
 * Asserte qu'EXACTEMENT N entries matchent. Utile pour idempotence
 * (ex: F-01 attend que 5× replay d'un event ne produit qu'1 entry
 * `billing.subscription.activated`).
 */
export async function assertAuditCount(
  opts: FindAuditOpts,
  expectedCount: number,
): Promise<AuditEntry[]> {
  const entries = await findAuditEntries({ ...opts, limit: Math.max(expectedCount + 5, 10) });
  if (entries.length !== expectedCount) {
    throw new Error(
      `[mega/audit-log] attendu ${expectedCount} entries pour ${JSON.stringify(opts)}, ` +
        `trouvé ${entries.length}.`,
    );
  }
  return entries;
}

/**
 * Asserte qu'AUCUNE entry n'existe pour les critères. Utile pour les
 * tests d'anti-régression (ex: D-04 "grant_manual immunity" ne doit
 * laisser AUCUNE entry `billing.downgrade.dispatched`).
 */
export async function assertNoAuditEntry(opts: FindAuditOpts): Promise<void> {
  const entries = await findAuditEntries({ ...opts, limit: 1 });
  if (entries.length > 0) {
    throw new Error(
      `[mega/audit-log] entry inattendue trouvée pour ${JSON.stringify(opts)}: ` +
        `id=${entries[0].id} action=${entries[0].action} created_at=${entries[0].createdAt}`,
    );
  }
}
