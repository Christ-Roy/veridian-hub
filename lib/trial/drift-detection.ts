/**
 * Drift detection — `tenant_trials.state` vs réalité Stripe.
 *
 * Cron quotidien (`.github/workflows/hub-trial-drift-cron.yml`) qui scanne
 * tous les rows `tenant_trials` non-terminaux ou tout juste convertis et les
 * compare à l'état réel des subscriptions Stripe du customer. Détecte les
 * désync laissées par :
 *
 *  - un webhook Stripe loupé (signature KO, IP allowlist, DB KO)
 *  - une row tenant_trials arrivée après le checkout (replay
 *    `tenant.activity_threshold_reached` post-paiement)
 *  - une bascule status manuelle Stripe non répercutée côté Hub
 *
 * Référence : `todo/2026-05-24-drift-detection-trial-vs-sub.md`,
 *             `docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md` §3.3,
 *             `lib/sync/reconcile.ts` (pattern dry-run cron).
 *
 * MODE PAR DÉFAUT : **report-only**. Aucune écriture côté Hub. Le rationale
 * miroir de `reconcile.ts` : on observe d'abord, on auto-corrige une fois
 * qu'on a une volumétrie réelle et qu'on a validé que les drifts détectés
 * sont bien des bugs et pas du normal (ex : sub annulée hier, tenant
 * volontairement gardé en trial expired pour audit). L'opt-in auto-fix
 * arrivera dans un sprint ultérieur.
 *
 * Stratégie de scan :
 *  1. SELECT tenant_trials WHERE state IN ('trial_active','converted','expired')
 *     (les 3 états "intéressants" pour cross-check vs Stripe — eligible /
 *      trial_ending_soon ne nous intéressent pas pour le drift sub-vs-trial)
 *  2. Par chunks de 100 (configurable), pour chaque tenant_trial row :
 *      - Résoudre tenant_id → user.stripe_customer_id (cascade slug/uuid/notifuse_slug)
 *      - Si stripe_customer_id absent → skip (user n'a jamais checkout)
 *      - Stripe API `subscriptions.list({customer, status: 'all', limit: 10})`
 *      - Catégoriser le drift (cf 3 cas dans le ticket)
 *  3. Agréger + log structuré
 *
 * Performance : 1 chunk = 100 tenants, ~2 queries DB + 100 calls Stripe
 * (rate limit Stripe = 100 read/s en live, donc ~1s par chunk).
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import { prisma as defaultPrisma } from '@/lib/prisma';
import { stripe as defaultStripe } from '@/utils/stripe/config';

/** États `tenant_trials` qu'on cross-check vs Stripe. */
export const DRIFT_TARGET_STATES = [
  'trial_active',
  'converted',
  'expired',
] as const;

export type DriftTargetState = (typeof DRIFT_TARGET_STATES)[number];

/** Sévérités drift, classées par urgence opérationnelle. */
export type DriftSeverity = 'low' | 'medium' | 'high';

/**
 * Détail d'un drift détecté entre tenant_trials et Stripe.
 *
 * `severity` :
 *   - high   = expired mais sub Stripe active (downgrade auto fait, user paie
 *              mais reste downgradé → impact business immédiat)
 *   - medium = trial_active mais sub Stripe active (purge ratée, user paie
 *              mais on le considère toujours en essai → cron trial-tick
 *              risque de le downgrader à l'échéance)
 *   - low    = converted mais sub Stripe inexistante/canceled (Hub croit que
 *              le user paie mais Stripe dit non → impact billing seulement)
 */
export interface TrialSubDrift {
  tenantId: string;
  app: string;
  userId: string | null;
  stripeCustomerId: string | null;
  trialState: DriftTargetState;
  /**
   * Status Stripe agrégé : si plusieurs subs (rare), on remonte la plus
   * favorable au user — `active` > `trialing` > `past_due` > `canceled` >
   * `incomplete` > `unpaid` > `none`. `none` = aucune subscription Stripe.
   */
  stripeStatus: string;
  severity: DriftSeverity;
  observedAt: string;
}

export interface DriftDetectionSummary {
  totalScanned: number;
  skippedNoStripeCustomer: number;
  stripeErrors: number;
  driftsDetected: number;
  drifts: TrialSubDrift[];
  startedAt: string;
  durationMs: number;
  mode: 'report-only';
  errors: Array<{ tenantId?: string; message: string }>;
}

export interface DriftDetectionOptions {
  /** Override Prisma client (tests). */
  prisma?: PrismaClient;
  /** Override Stripe client (tests). */
  stripeClient?: Pick<Stripe, 'subscriptions'>;
  /** Taille des chunks pour batch DB + Stripe. Défaut 100, clamp 1..500. */
  chunkSize?: number;
  /** Mode auto-fix (P1+). Bloqué en dur côté code v1. */
  autoFix?: boolean;
  /** Limit globale de rows à scanner (tests / debug). Défaut Infinity. */
  limit?: number;
}

/**
 * Statuts Stripe considérés "actifs" (le user paie effectivement OU est en
 * période de grâce dette). Cohérent avec
 * `lib/trial/run-tick.ts:defaultBatchResolveHasActiveSub`.
 */
const ACTIVE_STRIPE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
]);

/** Priorité d'agrégation quand un customer a plusieurs subs (rare). */
const STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  canceled: 3,
  incomplete: 4,
  incomplete_expired: 5,
  unpaid: 6,
  paused: 7,
};

function bestStripeStatus(statuses: string[]): string {
  if (statuses.length === 0) return 'none';
  return statuses
    .slice()
    .sort(
      (a, b) =>
        (STATUS_PRIORITY[a] ?? 99) - (STATUS_PRIORITY[b] ?? 99),
    )[0];
}

/**
 * Catégorise un drift entre l'état Hub (`tenant_trials.state`) et l'état
 * Stripe agrégé. Renvoie `null` si pas de drift.
 */
export function classifyDrift(
  trialState: DriftTargetState,
  stripeStatus: string,
): DriftSeverity | null {
  const stripeActive = ACTIVE_STRIPE_STATUSES.has(stripeStatus);

  // Cas 1 : trial_active + Stripe active = purge ratée (medium)
  if (trialState === 'trial_active' && stripeActive) return 'medium';

  // Cas 2 : converted + Stripe pas active = Hub croit user paie mais non (low)
  // On considère drift uniquement si la sub a un statut "négatif" (canceled,
  // incomplete, unpaid, none). Une sub `past_due` est encore "active" donc
  // pas un drift converted.
  if (trialState === 'converted' && !stripeActive) return 'low';

  // Cas 3 : expired + Stripe active = downgrade auto fait alors que user paie (high)
  if (trialState === 'expired' && stripeActive) return 'high';

  return null;
}

/**
 * Snapshot minimaliste d'un row tenant_trials enrichi avec le
 * stripe_customer_id du owner. Sortie du query batch ci-dessous.
 */
interface TenantTrialWithCustomer {
  tenantId: string;
  app: string;
  state: DriftTargetState;
  userId: string | null;
  stripeCustomerId: string | null;
}

/**
 * Charge un chunk de `tenant_trials` (filtrés sur `DRIFT_TARGET_STATES`) +
 * résout en batch tenant → user → stripeCustomerId. Exclut les tenants
 * soft-deleted (`deletedAt IS NOT NULL`).
 *
 * Retourne `null` quand il n'y a plus rien à scanner.
 *
 * Stratégie cursor : on pagine par (tenantId, app) ASC. Stable, déterministe,
 * et compatible PK composite de TenantTrial.
 */
async function loadChunk(
  p: PrismaClient,
  chunkSize: number,
  cursor: { tenantId: string; app: string } | null,
): Promise<TenantTrialWithCustomer[]> {
  const trials = await p.tenantTrial.findMany({
    where: {
      state: { in: DRIFT_TARGET_STATES as unknown as DriftTargetState[] },
      ...(cursor
        ? {
            OR: [
              { tenantId: { gt: cursor.tenantId } },
              {
                tenantId: cursor.tenantId,
                app: { gt: cursor.app },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ tenantId: 'asc' }, { app: 'asc' }],
    take: chunkSize,
    select: { tenantId: true, app: true, state: true },
  });

  if (trials.length === 0) return [];

  // Le `tenantId` côté tenant_trials peut être :
  //   - un UUID v4 → match Tenant.id
  //   - un slug humain → match Tenant.notifuseWorkspaceSlug ou Tenant.slug
  // On résout les 3 chemins en 1 query.
  const tenantIds = Array.from(new Set(trials.map((t) => t.tenantId)));

  const orClauses: Prisma.TenantWhereInput[] = [
    { id: { in: tenantIds } },
    { slug: { in: tenantIds } },
    { notifuseWorkspaceSlug: { in: tenantIds } },
  ];

  const tenants = await p.tenant.findMany({
    where: { OR: orClauses, deletedAt: null },
    select: {
      id: true,
      slug: true,
      notifuseWorkspaceSlug: true,
      userId: true,
    },
  });

  // Map tenant_trial.tenantId → Tenant.userId (UUID legacy bridge).
  const userIdByTrialKey = new Map<string, string>();
  for (const t of tenants) {
    userIdByTrialKey.set(t.id, t.userId);
    if (t.slug) userIdByTrialKey.set(t.slug, t.userId);
    if (t.notifuseWorkspaceSlug)
      userIdByTrialKey.set(t.notifuseWorkspaceSlug, t.userId);
  }

  // Lookup batch User.stripeCustomerId via supabaseUserId (UUID bridge).
  const supabaseIds = Array.from(
    new Set(Array.from(userIdByTrialKey.values())),
  );
  const users = supabaseIds.length
    ? await p.user.findMany({
        where: { supabaseUserId: { in: supabaseIds } },
        select: { id: true, supabaseUserId: true, stripeCustomerId: true },
      })
    : [];
  const stripeCustomerBySid = new Map<
    string,
    { id: string; stripeCustomerId: string | null }
  >();
  for (const u of users) {
    if (u.supabaseUserId) {
      stripeCustomerBySid.set(u.supabaseUserId, {
        id: u.id,
        stripeCustomerId: u.stripeCustomerId,
      });
    }
  }

  return trials.map((t) => {
    const sid = userIdByTrialKey.get(t.tenantId) ?? null;
    const userRec = sid ? stripeCustomerBySid.get(sid) : null;
    return {
      tenantId: t.tenantId,
      app: t.app,
      state: t.state as DriftTargetState,
      userId: userRec?.id ?? null,
      stripeCustomerId: userRec?.stripeCustomerId ?? null,
    } satisfies TenantTrialWithCustomer;
  });
}

/**
 * Point d'entrée du cron. Appelé par
 * `app/api/cron/trial-drift-detection/route.ts` (thin wrapper auth Bearer).
 *
 * Bloque l'auto-fix en dur tant qu'on n'a pas observé en réel — comportement
 * miroir de `runReconcile` (P0 lock).
 */
export async function detectTrialSubDrifts(
  options: DriftDetectionOptions = {},
): Promise<DriftDetectionSummary> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const p = options.prisma ?? defaultPrisma;
  const stripe = options.stripeClient ?? (defaultStripe as Pick<Stripe, 'subscriptions'>);
  const chunkSize = Math.min(
    Math.max(Math.floor(options.chunkSize ?? 100), 1),
    500,
  );
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const errors: DriftDetectionSummary['errors'] = [];

  if (options.autoFix === true) {
    errors.push({
      message:
        'auto-fix requested but not implemented in v1 — defaulting to report-only',
    });
  }

  let totalScanned = 0;
  let skippedNoStripeCustomer = 0;
  let stripeErrors = 0;
  const drifts: TrialSubDrift[] = [];

  let cursor: { tenantId: string; app: string } | null = null;

  while (totalScanned < limit) {
    const remaining = limit - totalScanned;
    const take = Math.min(chunkSize, remaining);
    const chunk = await loadChunk(p, take, cursor);
    if (chunk.length === 0) break;

    for (const row of chunk) {
      totalScanned += 1;

      if (!row.stripeCustomerId) {
        skippedNoStripeCustomer += 1;
        continue;
      }

      try {
        // Stripe rate limit live = 100 read/s. On reste séquentiel par chunk
        // pour ne pas saturer + on garde un timeout court via le SDK default.
        const subs = await stripe.subscriptions.list({
          customer: row.stripeCustomerId,
          status: 'all',
          limit: 10,
        });
        const stripeStatus = bestStripeStatus(
          subs.data.map((s: Stripe.Subscription) => s.status),
        );
        const severity = classifyDrift(row.state, stripeStatus);
        if (severity) {
          drifts.push({
            tenantId: row.tenantId,
            app: row.app,
            userId: row.userId,
            stripeCustomerId: row.stripeCustomerId,
            trialState: row.state,
            stripeStatus,
            severity,
            observedAt: startedAt,
          });
        }
      } catch (err) {
        stripeErrors += 1;
        errors.push({
          tenantId: row.tenantId,
          message:
            err instanceof Error
              ? `stripe_list_failed: ${err.message}`
              : 'stripe_list_failed: unknown',
        });
      }
    }

    // Avance le curseur sur le dernier (tenantId, app) du chunk.
    const last = chunk[chunk.length - 1];
    cursor = { tenantId: last.tenantId, app: last.app };

    // Si on a reçu moins que demandé, on est arrivé au bout.
    if (chunk.length < take) break;
  }

  const summary: DriftDetectionSummary = {
    totalScanned,
    skippedNoStripeCustomer,
    stripeErrors,
    driftsDetected: drifts.length,
    drifts: drifts.slice(0, 200), // cap payload HTTP
    startedAt,
    durationMs: Date.now() - startMs,
    mode: 'report-only',
    errors,
  };

  // Log structuré Grafana Loki. Niveau `warn` si drifts > 0 pour faciliter
  // les filtres d'alerte futurs (Robert peut câbler un Loki alert sur
  // `level=warn AND tag=[cron-trial-drift]`).
  const logLevel = drifts.length > 0 ? 'warn' : 'info';
  // eslint-disable-next-line no-console
  console[logLevel === 'warn' ? 'warn' : 'log'](
    JSON.stringify({
      tag: '[cron-trial-drift]',
      level: logLevel,
      mode: summary.mode,
      totalScanned: summary.totalScanned,
      skippedNoStripeCustomer: summary.skippedNoStripeCustomer,
      stripeErrors: summary.stripeErrors,
      driftsDetected: summary.driftsDetected,
      duration_ms: summary.durationMs,
      ts: startedAt,
      sample: summary.drifts.slice(0, 10).map((d) => ({
        tenantId: d.tenantId,
        app: d.app,
        trialState: d.trialState,
        stripeStatus: d.stripeStatus,
        severity: d.severity,
      })),
    }),
  );

  return summary;
}
