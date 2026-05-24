/**
 * Logique d'orchestration de la trial state machine — extraite du route
 * handler pour permettre l'export TS arbitraire (Next.js App Router refuse
 * tout export hors `runtime/dynamic/maxDuration/etc.` depuis un route file).
 *
 * Le route handler `app/api/cron/trial-tick/route.ts` reste un thin wrapper
 * autour de `runTrialTick` — il fait juste l'auth Bearer CRON_SECRET et
 * délègue. Tous les tests unitaires de la state machine importent depuis
 * ce module.
 *
 * Pour chaque row `hub_app.tenant_trials` non-terminale :
 *
 *   1. state=eligible depuis ≥48h
 *      → state=trial_active, trial_started_at=NOW, trial_ends_at=NOW+15d
 *      → appel notifuseClient.updatePlan(plan=pro)
 *      → email "trial démarré"
 *      → notif Telegram Robert
 *
 *   2. state=trial_active depuis ≥12j ET ending_soon_notified=false
 *      → ending_soon_notified=true
 *      → email "expire dans 3j"
 *
 *   3. state=trial_active ET trial_ends_at ≤ NOW
 *      → si Stripe sub active → state=converted (no downgrade)
 *      → sinon → state=expired, expired_at=NOW
 *         + appel notifuseClient.updatePlan(plan=free)
 *         + email "trial terminé"
 *         + notif Telegram Robert
 *
 * Race conditions : transaction PG `SELECT ... FOR UPDATE SKIP LOCKED` sur
 * chaque tranche pour qu'une 2e instance cron sur la même fenêtre ne
 * re-traite pas les mêmes rows. Si la même row est verrouillée, on la skip
 * — elle sera reprise au tick suivant (30 min plus tard).
 *
 * Idempotence : si le cron crashe entre l'UPDATE state et l'appel
 * downstream, le state suivant fera tout repartir. Pour les appels
 * downstream (update-plan) idempotents côté Notifuse, plusieurs appels
 * successifs sont safe.
 *
 * Perf — batch resolvers (fix N+1, 2026-05-21) :
 *   Avant la boucle de chaque phase, on batch-resolve une fois :
 *     - les owner emails via 2 queries (tenant + user) au lieu de N×2
 *     - les Stripe subs actives via 2 queries au lieu de N×2 (phase 3)
 *   Lookup en mémoire dans la boucle. Pour un batch de 100 rows :
 *     - Phase 1 : 200 queries → 2
 *     - Phase 2 : 200 queries → 2
 *     - Phase 3 : 400 queries → 4
 *   Total : ~800 → ~8 queries.
 *
 * Référence : `todo/2026-05-21-trial-state-machine.md`,
 *             `todo/2026-05-21-fix-n1-trial-tick.md`,
 *             `docs/PRICING-VERIDIAN.md` §"Flow trial complet",
 *             `docs/CONTRAT-HUB.md` §"Trial state machine".
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { buildNotifuseClient } from '@/lib/notifuse/admin-helpers';
import type { NotifuseClient } from '@/lib/notifuse/client';
import type { NotifusePlan } from '@/lib/notifuse/types';
import { sendMail } from '@/lib/email/send';
import { sendTelegramAlert } from '@/lib/notifications/telegram';
import {
  buildTrialEndingSoonEmail,
  buildTrialExpiredEmail,
  buildTrialStartedEmail,
} from '@/lib/email/templates/trial';
import { computeTrialEndsAt } from '@/lib/trial/transitions';
import {
  TRIAL_ELIGIBLE_WAIT_HOURS,
  TRIAL_NOTIFY_ENDING_SOON_DAYS,
} from '@/lib/trial/constants';

export interface TickSummary {
  activated: number;
  notified: number;
  expired: number;
  converted: number;
  errors: Array<{ tenantId: string; app: string; phase: string; error: string }>;
}

/**
 * Options injectables pour les tests (mocks). En prod, undefined → fabrique
 * les vrais clients depuis ENV.
 *
 * Note compat : `hasActiveStripeSubForTenant` (signature single) reste
 * supportée pour les tests existants. En interne, on l'enveloppe dans un
 * appel séquentiel sur les tenants du batch — pas de perte de fonctionnalité,
 * juste pas de gain perf si tu choisis cette voie. La voie perf est
 * `hasActiveStripeSubBatch` (un appel pour tout le batch).
 */
export interface TickDeps {
  notifuseClient?: NotifuseClient;
  sendEmail?: (params: { to: string; subject: string; html: string }) => Promise<void>;
  notifyTelegram?: (message: string) => Promise<boolean>;
  /** @deprecated Garder pour back-compat tests. Préférer `hasActiveStripeSubBatch`. */
  hasActiveStripeSubForTenant?: (tenantId: string, app: string) => Promise<boolean>;
  /** Batch resolver : 1 appel pour tout le batch finalize. */
  hasActiveStripeSubBatch?: (
    tenantIds: string[],
  ) => Promise<Map<string, boolean>>;
  /** Batch resolver : 1 appel pour tout le batch d'une phase. */
  resolveOwnerEmailBatch?: (
    tenantIds: string[],
  ) => Promise<Map<string, string | null>>;
  now?: Date;
}

/**
 * Exécute un tick complet de la state machine.
 */
export async function runTrialTick(deps: TickDeps = {}): Promise<TickSummary> {
  const notifuseClient = deps.notifuseClient ?? resolveNotifuseClient();
  const sendEmail =
    deps.sendEmail ??
    (async (params) =>
      sendMail({
        to: params.to,
        subject: params.subject,
        html: params.html,
      }));
  const notifyTelegram = deps.notifyTelegram ?? sendTelegramAlert;

  // Batch resolvers — par défaut tapent la DB en 2 queries chacun. Les tests
  // peuvent surcharger via deps pour piloter en mémoire.
  const resolveOwnerEmailBatch =
    deps.resolveOwnerEmailBatch ?? defaultBatchResolveOwnerEmails;

  // Pour hasActiveStripeSubBatch on a une couche de compat : si seulement
  // `hasActiveStripeSubForTenant` est fourni (legacy tests), on wrap.
  const hasActiveStripeSubBatch: (
    tenantIds: string[],
  ) => Promise<Map<string, boolean>> = deps.hasActiveStripeSubBatch
    ? deps.hasActiveStripeSubBatch
    : deps.hasActiveStripeSubForTenant
      ? async (tenantIds: string[]) => {
          // Compat tests legacy : appel single par tenant (perf dégradée
          // assumée — seuls les tests prennent ce chemin).
          const single = deps.hasActiveStripeSubForTenant!;
          const result = new Map<string, boolean>();
          for (const id of tenantIds) {
            // L'app n'est plus connue à ce niveau ; on passe '' qui était
            // ignoré dans defaultHasActiveStripeSub de toute façon.
            result.set(id, await single(id, ''));
          }
          return result;
        }
      : defaultBatchResolveHasActiveSub;

  const now = deps.now ?? new Date();

  const summary: TickSummary = {
    activated: 0,
    notified: 0,
    expired: 0,
    converted: 0,
    errors: [],
  };

  await processActivations(
    now,
    notifuseClient,
    sendEmail,
    notifyTelegram,
    resolveOwnerEmailBatch,
    summary,
  );
  await processEndingSoon(
    now,
    hasActiveStripeSubBatch,
    sendEmail,
    resolveOwnerEmailBatch,
    summary,
  );
  await processFinalize(
    now,
    notifuseClient,
    hasActiveStripeSubBatch,
    sendEmail,
    notifyTelegram,
    resolveOwnerEmailBatch,
    summary,
  );

  return summary;
}

// ─────────────────────────────────────────────────────────────────────
// Phase 1 — Activations (eligible → trial_active)
// ─────────────────────────────────────────────────────────────────────

async function processActivations(
  now: Date,
  notifuseClient: NotifuseClient,
  sendEmail: NonNullable<TickDeps['sendEmail']>,
  notifyTelegram: NonNullable<TickDeps['notifyTelegram']>,
  resolveOwnerEmailBatch: (
    tenantIds: string[],
  ) => Promise<Map<string, string | null>>,
  summary: TickSummary,
): Promise<void> {
  const eligibleCutoff = new Date(
    now.getTime() - TRIAL_ELIGIBLE_WAIT_HOURS * 60 * 60 * 1000,
  );

  // Filtre soft-deleted obligatoire (cf ticket 2026-05-22-trial-tick-filtre-soft-deleted).
  // tenant_id peut être un UUID Hub, un slug Notifuse ou un slug Hub
  // (cf convention resolveOwnerEmail) — triple OR pour matcher.
  const rows = await prisma.$queryRaw<
    Array<{ tenant_id: string; app: string; eligible_at: Date }>
  >(Prisma.sql`
    SELECT tenant_id, app, eligible_at
    FROM hub_app.tenant_trials
    WHERE state = 'eligible'
      AND eligible_at IS NOT NULL
      AND eligible_at <= ${eligibleCutoff}
      AND EXISTS (
        SELECT 1 FROM hub_app.tenants t
        WHERE (
          t.id::text = tenant_trials.tenant_id
          OR t.notifuse_workspace_slug = tenant_trials.tenant_id
          OR t.slug = tenant_trials.tenant_id
        )
        AND t.deleted_at IS NULL
      )
    ORDER BY eligible_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  if (rows.length === 0) return;

  // Batch resolve owner emails (1 fois pour tout le batch).
  const tenantIds = rows.map((r) => r.tenant_id);
  const emailMap = await resolveOwnerEmailBatch(tenantIds);

  for (const row of rows) {
    try {
      const trialEndsAt = computeTrialEndsAt(now);

      await prisma.tenantTrial.update({
        where: {
          tenantId_app: { tenantId: row.tenant_id, app: row.app },
        },
        data: {
          state: 'trial_active',
          trialStartedAt: now,
          trialEndsAt,
          updatedAt: now,
        },
      });

      await callUpdatePlan(notifuseClient, row.app, row.tenant_id, 'pro');

      const ownerEmail = emailMap.get(row.tenant_id) ?? null;
      if (ownerEmail) {
        const tpl = buildTrialStartedEmail({
          app: row.app,
          trialEndsAt,
        });
        await sendEmail({ to: ownerEmail, subject: tpl.subject, html: tpl.html });
      }

      await notifyTelegram(
        `🎉 <b>Trial Pro activé</b>\napp=${row.app}\ntenant=${row.tenant_id}\nexpire=${trialEndsAt.toISOString()}`,
      ).catch(() => undefined);

      summary.activated += 1;
    } catch (err) {
      summary.errors.push({
        tenantId: row.tenant_id,
        app: row.app,
        phase: 'activate',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — Ending soon notification (J+12)
// ─────────────────────────────────────────────────────────────────────

async function processEndingSoon(
  now: Date,
  hasActiveStripeSubBatch: (
    tenantIds: string[],
  ) => Promise<Map<string, boolean>>,
  sendEmail: NonNullable<TickDeps['sendEmail']>,
  resolveOwnerEmailBatch: (
    tenantIds: string[],
  ) => Promise<Map<string, string | null>>,
  summary: TickSummary,
): Promise<void> {
  const notifyCutoff = new Date(
    now.getTime() - TRIAL_NOTIFY_ENDING_SOON_DAYS * 24 * 60 * 60 * 1000,
  );

  // Filtre soft-deleted (cf phase eligible) — un tenant supprimé pendant
  // son trial actif ne doit pas recevoir "expire dans 3j".
  const rows = await prisma.$queryRaw<
    Array<{ tenant_id: string; app: string; trial_ends_at: Date }>
  >(Prisma.sql`
    SELECT tenant_id, app, trial_ends_at
    FROM hub_app.tenant_trials
    WHERE state = 'trial_active'
      AND ending_soon_notified = FALSE
      AND trial_started_at IS NOT NULL
      AND trial_started_at <= ${notifyCutoff}
      AND EXISTS (
        SELECT 1 FROM hub_app.tenants t
        WHERE (
          t.id::text = tenant_trials.tenant_id
          OR t.notifuse_workspace_slug = tenant_trials.tenant_id
          OR t.slug = tenant_trials.tenant_id
        )
        AND t.deleted_at IS NULL
      )
    ORDER BY trial_started_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  if (rows.length === 0) return;

  const tenantIds = rows.map((r) => r.tenant_id);

  // Défense en profondeur (cf docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md) :
  //   Le webhook Stripe purge `tenant_trials → converted` quand sub active
  //   (cf utils/stripe/prisma-sync.ts §1ter). Si pour une raison X la purge
  //   a échoué (webhook KO, DB désync, etc.) et qu'une row reste à
  //   `trial_active` alors que le user paie déjà, on NE veut PAS lui envoyer
  //   "ton essai expire dans 3j". On batch-resolve les subs actives ici et
  //   on skip + auto-corrige à `converted` les rows qui ont une sub.
  const [emailMap, subMap] = await Promise.all([
    resolveOwnerEmailBatch(tenantIds),
    hasActiveStripeSubBatch(tenantIds),
  ]);

  for (const row of rows) {
    try {
      const hasSub = subMap.get(row.tenant_id) ?? false;
      if (hasSub) {
        // Le user paie déjà — on purge le résidu trial et on skip l'email.
        await prisma.tenantTrial.update({
          where: {
            tenantId_app: { tenantId: row.tenant_id, app: row.app },
          },
          data: { state: 'converted', updatedAt: now },
        });
        console.log(
          `[trial-tick] notify-ending-soon skipped (sub active) tenant=${row.tenant_id} app=${row.app} → purged to converted`,
        );
        summary.converted += 1;
        continue;
      }

      await prisma.tenantTrial.update({
        where: {
          tenantId_app: { tenantId: row.tenant_id, app: row.app },
        },
        data: { endingSoonNotified: true, updatedAt: now },
      });

      const ownerEmail = emailMap.get(row.tenant_id) ?? null;
      if (ownerEmail) {
        const tpl = buildTrialEndingSoonEmail({
          app: row.app,
          trialEndsAt: row.trial_ends_at,
        });
        await sendEmail({ to: ownerEmail, subject: tpl.subject, html: tpl.html });
      }

      summary.notified += 1;
    } catch (err) {
      summary.errors.push({
        tenantId: row.tenant_id,
        app: row.app,
        phase: 'notify',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Phase 3 — Finalize (J+15 : expired ou converted)
// ─────────────────────────────────────────────────────────────────────

async function processFinalize(
  now: Date,
  notifuseClient: NotifuseClient,
  hasActiveStripeSubBatch: (
    tenantIds: string[],
  ) => Promise<Map<string, boolean>>,
  sendEmail: NonNullable<TickDeps['sendEmail']>,
  notifyTelegram: NonNullable<TickDeps['notifyTelegram']>,
  resolveOwnerEmailBatch: (
    tenantIds: string[],
  ) => Promise<Map<string, string | null>>,
  summary: TickSummary,
): Promise<void> {
  // Filtre soft-deleted (cf phases précédentes) — pas de downgrade
  // notifuse update-plan plan=free sur tenant déjà nettoyé.
  const rows = await prisma.$queryRaw<
    Array<{ tenant_id: string; app: string; trial_ends_at: Date }>
  >(Prisma.sql`
    SELECT tenant_id, app, trial_ends_at
    FROM hub_app.tenant_trials
    WHERE state = 'trial_active'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at <= ${now}
      AND EXISTS (
        SELECT 1 FROM hub_app.tenants t
        WHERE (
          t.id::text = tenant_trials.tenant_id
          OR t.notifuse_workspace_slug = tenant_trials.tenant_id
          OR t.slug = tenant_trials.tenant_id
        )
        AND t.deleted_at IS NULL
      )
    ORDER BY trial_ends_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  if (rows.length === 0) return;

  // Batch resolve : 1 appel pour les emails, 1 appel pour les subs Stripe.
  const tenantIds = rows.map((r) => r.tenant_id);
  const [emailMap, subMap] = await Promise.all([
    resolveOwnerEmailBatch(tenantIds),
    hasActiveStripeSubBatch(tenantIds),
  ]);

  for (const row of rows) {
    try {
      const hasSub = subMap.get(row.tenant_id) ?? false;

      if (hasSub) {
        await prisma.tenantTrial.update({
          where: {
            tenantId_app: { tenantId: row.tenant_id, app: row.app },
          },
          data: { state: 'converted', updatedAt: now },
        });
        summary.converted += 1;
        await notifyTelegram(
          `💳 <b>Trial converti (Stripe sub active)</b>\napp=${row.app}\ntenant=${row.tenant_id}`,
        ).catch(() => undefined);
        continue;
      }

      await prisma.tenantTrial.update({
        where: {
          tenantId_app: { tenantId: row.tenant_id, app: row.app },
        },
        data: { state: 'expired', expiredAt: now, updatedAt: now },
      });

      await callUpdatePlan(notifuseClient, row.app, row.tenant_id, 'free');

      const ownerEmail = emailMap.get(row.tenant_id) ?? null;
      if (ownerEmail) {
        const tpl = buildTrialExpiredEmail({
          app: row.app,
          trialEndsAt: row.trial_ends_at,
        });
        await sendEmail({ to: ownerEmail, subject: tpl.subject, html: tpl.html });
      }

      await notifyTelegram(
        `📉 <b>Trial expiré + downgrade free</b>\napp=${row.app}\ntenant=${row.tenant_id}`,
      ).catch(() => undefined);

      summary.expired += 1;
    } catch (err) {
      summary.errors.push({
        tenantId: row.tenant_id,
        app: row.app,
        phase: 'finalize',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function resolveNotifuseClient(): NotifuseClient {
  const client = buildNotifuseClient();
  // buildNotifuseClient retourne soit le client, soit une NextResponse
  // (pattern Next.js route handlers). Côté cron on veut throw.
  if ('json' in client) {
    throw new Error(
      'Notifuse client not configured (NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET)',
    );
  }
  return client;
}

/**
 * Dispatch update-plan vers l'app cible. Pour l'instant seul Notifuse est
 * branché — Prospection / Analytics ne consomment pas encore update-plan
 * dans la state machine trial (leur signal d'engagement n'est pas défini).
 */
async function callUpdatePlan(
  notifuseClient: NotifuseClient,
  app: string,
  tenantId: string,
  plan: NotifusePlan,
): Promise<void> {
  if (app === 'notifuse') {
    await notifuseClient.updatePlan({ tenantId, plan });
    return;
  }
  console.warn(
    `[cron-trial-tick] update-plan skipped for app=${app} (no client wired yet) tenant=${tenantId} plan=${plan}`,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Batch resolve des owner emails pour une liste d'identifiants `tenant_id`
 * (cf convention : peut être un UUID Hub, un slug Notifuse, ou un slug Hub).
 *
 * Effectue exactement 2 queries DB :
 *   1. `prisma.tenant.findMany` avec WHERE IN sur les 3 colonnes possibles
 *   2. `prisma.user.findMany` pour les tenants sans `notifuseUserEmail`
 *
 * Retourne une Map qui mappe chaque identifiant fourni → email (ou null si
 * pas trouvé). Lookup O(1) dans la boucle d'appel.
 */
async function defaultBatchResolveOwnerEmails(
  tenantIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (tenantIds.length === 0) return result;

  const uniqueIds = Array.from(new Set(tenantIds));
  const uuids = uniqueIds.filter(isUuid);
  const nonUuids = uniqueIds.filter((id) => !isUuid(id));

  // Une seule query qui couvre les 3 colonnes possibles via OR + IN.
  // Si une liste est vide on omet sa branche pour ne pas générer un OR vide.
  const orClauses: Prisma.TenantWhereInput[] = [];
  if (uuids.length) orClauses.push({ id: { in: uuids } });
  if (nonUuids.length) orClauses.push({ notifuseWorkspaceSlug: { in: nonUuids } });
  if (nonUuids.length) orClauses.push({ slug: { in: nonUuids } });

  if (orClauses.length === 0) return result;

  const tenants = await prisma.tenant.findMany({
    where: { OR: orClauses },
    select: {
      id: true,
      slug: true,
      notifuseWorkspaceSlug: true,
      userId: true,
      notifuseUserEmail: true,
    },
  });

  // Batch resolve les users pour les tenants sans notifuseUserEmail direct.
  const userUuids = Array.from(
    new Set(
      tenants
        .filter((t) => !t.notifuseUserEmail)
        .map((t) => t.userId),
    ),
  );
  const users = userUuids.length
    ? await prisma.user.findMany({
        where: { supabaseUserId: { in: userUuids } },
        select: { supabaseUserId: true, email: true },
      })
    : [];
  const emailByUserUuid = new Map(
    users
      .filter((u): u is { supabaseUserId: string; email: string } => !!u.supabaseUserId)
      .map((u) => [u.supabaseUserId, u.email]),
  );

  // Construit la map : chaque tenant peut être lookupé par id, slug ou
  // notifuseWorkspaceSlug — on remplit les 3 entrées pour qu'un lookup
  // par l'un quelconque fonctionne.
  for (const t of tenants) {
    const email = t.notifuseUserEmail ?? emailByUserUuid.get(t.userId) ?? null;
    result.set(t.id, email);
    if (t.slug) result.set(t.slug, email);
    if (t.notifuseWorkspaceSlug) result.set(t.notifuseWorkspaceSlug, email);
  }

  // Pour les IDs demandés mais non trouvés, on met null explicite
  // (consommateur peut différencier "pas demandé" vs "demandé, pas trouvé").
  for (const id of uniqueIds) {
    if (!result.has(id)) result.set(id, null);
  }

  return result;
}

/**
 * Batch resolve "a une Stripe Subscription active" pour une liste de
 * tenant ids. Effectue exactement 2 queries DB :
 *   1. `prisma.tenant.findMany` pour mapper tenant_id → userId
 *   2. `prisma.subscription.findMany` pour récupérer les subs actives
 *
 * Logique active sub : status ∈ {'active', 'trialing', 'past_due'}.
 * Cf doc inline dans le helper single legacy ci-dessous.
 *
 * Si la table locale `subscriptions` désync (rare, on a stripe_events
 * qui rejoue), le pire scénario est de downgrader un user qui a en fait
 * une sub active — il sera réactivé par le prochain webhook
 * subscription.updated. Robert préfère ça à un cron qui dépend de
 * l'API Stripe pour tourner.
 */
async function defaultBatchResolveHasActiveSub(
  tenantIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (tenantIds.length === 0) return result;

  const uniqueIds = Array.from(new Set(tenantIds));
  const uuids = uniqueIds.filter(isUuid);
  const nonUuids = uniqueIds.filter((id) => !isUuid(id));

  const orClauses: Prisma.TenantWhereInput[] = [];
  if (uuids.length) orClauses.push({ id: { in: uuids } });
  if (nonUuids.length) orClauses.push({ notifuseWorkspaceSlug: { in: nonUuids } });
  if (nonUuids.length) orClauses.push({ slug: { in: nonUuids } });

  if (orClauses.length === 0) {
    for (const id of uniqueIds) result.set(id, false);
    return result;
  }

  const tenants = await prisma.tenant.findMany({
    where: { OR: orClauses },
    select: {
      id: true,
      slug: true,
      notifuseWorkspaceSlug: true,
      userId: true,
    },
  });

  const userUuids = Array.from(new Set(tenants.map((t) => t.userId)));
  const subs = userUuids.length
    ? await prisma.subscription.findMany({
        where: {
          userId: { in: userUuids },
          status: { in: ['active', 'trialing', 'past_due'] },
        },
        select: { userId: true },
      })
    : [];
  const activeUserUuids = new Set(subs.map((s) => s.userId));

  for (const t of tenants) {
    const hasSub = activeUserUuids.has(t.userId);
    result.set(t.id, hasSub);
    if (t.slug) result.set(t.slug, hasSub);
    if (t.notifuseWorkspaceSlug) result.set(t.notifuseWorkspaceSlug, hasSub);
  }

  // Pour les IDs demandés mais non trouvés (tenant supprimé entre le scan
  // et le batch resolve), on met false explicite.
  for (const id of uniqueIds) {
    if (!result.has(id)) result.set(id, false);
  }

  return result;
}
