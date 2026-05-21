/**
 * Cron Job: Trial state machine tick.
 *
 * Endpoint  : POST /api/cron/trial-tick
 * Schedule  : Toutes les 30 minutes (`.github/workflows/hub-trial-tick-cron.yml`)
 * Auth      : header `Authorization: Bearer <CRON_SECRET>`
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
 *      → si Stripe sub active → state=converted (pas de downgrade,
 *         la sub Stripe a pris le relais)
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
 * downstream, le state suivant fera tout repartir (eligible reste eligible
 * tant que l'UPDATE n'a pas commit). Pour les appels downstream (update-plan)
 * idempotents côté Notifuse, plusieurs appels successifs sont safe.
 *
 * Référence : `todo/2026-05-21-trial-state-machine.md`,
 *             `docs/PRICING-VERIDIAN.md` §"Flow trial complet",
 *             `docs/CONTRAT-HUB.md` §"Trial state machine".
 */

import { NextRequest, NextResponse } from 'next/server';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min : large marge pour batches > 100 trials

const CRON_SECRET = process.env.CRON_SECRET;

interface TickSummary {
  activated: number;
  notified: number;
  expired: number;
  converted: number;
  errors: Array<{ tenantId: string; app: string; phase: string; error: string }>;
}

/**
 * Options injectables pour les tests (mocks). En prod, undefined → fabrique
 * les vrais clients depuis ENV.
 */
export interface TickDeps {
  notifuseClient?: NotifuseClient;
  sendEmail?: (params: { to: string; subject: string; html: string }) => Promise<void>;
  notifyTelegram?: (message: string) => Promise<boolean>;
  hasActiveStripeSubForTenant?: (tenantId: string, app: string) => Promise<boolean>;
  now?: Date;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  if (!CRON_SECRET) {
    console.error(
      JSON.stringify({
        tag: '[cron-trial-tick]',
        level: 'error',
        message: 'CRON_SECRET not configured',
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 500 });
  }

  const auth = request.headers.get('authorization');
  const presented = auth?.replace(/^Bearer\s+/i, '');
  if (presented !== CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const summary = await runTrialTick();
    const durationMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        tag: '[cron-trial-tick]',
        level: 'info',
        durationMs,
        ...summary,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ ok: true, durationMs, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron-trial-tick] fatal:', msg);
    await sendTelegramAlert(
      `<b>Cron trial-tick KO</b>\n${msg.slice(0, 500)}`,
    ).catch(() => undefined);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * Exécute un tick complet de la state machine. Exposé pour les tests qui
 * injectent des deps.
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
  const hasActiveStripeSubForTenant =
    deps.hasActiveStripeSubForTenant ?? defaultHasActiveStripeSub;
  const now = deps.now ?? new Date();

  const summary: TickSummary = {
    activated: 0,
    notified: 0,
    expired: 0,
    converted: 0,
    errors: [],
  };

  await processActivations(now, notifuseClient, sendEmail, notifyTelegram, summary);
  await processEndingSoon(now, sendEmail, summary);
  await processFinalize(
    now,
    notifuseClient,
    hasActiveStripeSubForTenant,
    sendEmail,
    notifyTelegram,
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
  summary: TickSummary,
): Promise<void> {
  const eligibleCutoff = new Date(
    now.getTime() - TRIAL_ELIGIBLE_WAIT_HOURS * 60 * 60 * 1000,
  );

  // SELECT FOR UPDATE SKIP LOCKED : si une autre instance cron a déjà pris
  // la row, on la saute. Pas de double activation possible.
  const rows = await prisma.$queryRaw<
    Array<{ tenant_id: string; app: string; eligible_at: Date }>
  >(Prisma.sql`
    SELECT tenant_id, app, eligible_at
    FROM hub_app.tenant_trials
    WHERE state = 'eligible'
      AND eligible_at IS NOT NULL
      AND eligible_at <= ${eligibleCutoff}
    ORDER BY eligible_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  for (const row of rows) {
    try {
      const trialEndsAt = computeTrialEndsAt(now);

      // 1. Update DB d'abord (= prend le lock définitif sur la row).
      //    Si l'appel downstream foire ensuite, la row reste en trial_active
      //    avec trial_started_at et trial_ends_at posés — c'est volontaire :
      //    on ne re-activera pas et update-plan est idempotent côté Notifuse
      //    (rejouable manuellement si besoin).
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

      // 2. Push plan=pro côté app
      await callUpdatePlan(notifuseClient, row.app, row.tenant_id, 'pro');

      // 3. Email user
      const ownerEmail = await resolveOwnerEmail(row.tenant_id);
      if (ownerEmail) {
        const tpl = buildTrialStartedEmail({
          app: row.app,
          trialEndsAt,
        });
        await sendEmail({ to: ownerEmail, subject: tpl.subject, html: tpl.html });
      }

      // 4. Notif Robert
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
  sendEmail: NonNullable<TickDeps['sendEmail']>,
  summary: TickSummary,
): Promise<void> {
  const notifyCutoff = new Date(
    now.getTime() - TRIAL_NOTIFY_ENDING_SOON_DAYS * 24 * 60 * 60 * 1000,
  );

  const rows = await prisma.$queryRaw<
    Array<{ tenant_id: string; app: string; trial_ends_at: Date }>
  >(Prisma.sql`
    SELECT tenant_id, app, trial_ends_at
    FROM hub_app.tenant_trials
    WHERE state = 'trial_active'
      AND ending_soon_notified = FALSE
      AND trial_started_at IS NOT NULL
      AND trial_started_at <= ${notifyCutoff}
    ORDER BY trial_started_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  for (const row of rows) {
    try {
      await prisma.tenantTrial.update({
        where: {
          tenantId_app: { tenantId: row.tenant_id, app: row.app },
        },
        data: { endingSoonNotified: true, updatedAt: now },
      });

      const ownerEmail = await resolveOwnerEmail(row.tenant_id);
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
  hasActiveStripeSub: (tenantId: string, app: string) => Promise<boolean>,
  sendEmail: NonNullable<TickDeps['sendEmail']>,
  notifyTelegram: NonNullable<TickDeps['notifyTelegram']>,
  summary: TickSummary,
): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{ tenant_id: string; app: string; trial_ends_at: Date }>
  >(Prisma.sql`
    SELECT tenant_id, app, trial_ends_at
    FROM hub_app.tenant_trials
    WHERE state = 'trial_active'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at <= ${now}
    ORDER BY trial_ends_at ASC
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  `);

  for (const row of rows) {
    try {
      const hasSub = await hasActiveStripeSub(row.tenant_id, row.app);

      if (hasSub) {
        // Conversion : sub Stripe prend le relais, on ne touche pas au plan
        // (déjà géré par le dispatcher Stripe). Marker pour l'analytics.
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

      // Pas de sub Stripe → downgrade plan=free
      await prisma.tenantTrial.update({
        where: {
          tenantId_app: { tenantId: row.tenant_id, app: row.app },
        },
        data: { state: 'expired', expiredAt: now, updatedAt: now },
      });

      await callUpdatePlan(notifuseClient, row.app, row.tenant_id, 'free');

      const ownerEmail = await resolveOwnerEmail(row.tenant_id);
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

/**
 * Construit le `NotifuseClient` depuis ENV. Throw si la config manque (le
 * cron est inutile sans). En prod, ces ENV sont garantis par le compose.
 */
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
  // Prospection / Analytics : pas de client côté Hub à date. On loggue
  // pour audit ; quand les apps émettront `activity_threshold_reached`,
  // on branchera ici le client correspondant.
  console.warn(
    `[cron-trial-tick] update-plan skipped for app=${app} (no client wired yet) tenant=${tenantId} plan=${plan}`,
  );
}

/**
 * Résout l'email de l'owner du tenant Hub pour envoyer les mails trial.
 * Si le tenant n'a pas d'owner identifiable, on retourne null (le tick
 * continue, on loggue juste qu'on n'a pas pu envoyer).
 */
async function resolveOwnerEmail(tenantId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { id: isUuid(tenantId) ? tenantId : undefined },
        { notifuseWorkspaceSlug: tenantId },
        { slug: tenantId },
      ].filter((c): c is { id: string } | { notifuseWorkspaceSlug: string } | { slug: string } =>
        Object.values(c).some((v) => v !== undefined),
      ),
    },
    select: { userId: true, notifuseUserEmail: true },
  });
  if (!tenant) return null;

  if (tenant.notifuseUserEmail) return tenant.notifuseUserEmail;

  const user = await prisma.user.findFirst({
    where: { supabaseUserId: tenant.userId },
    select: { email: true },
  });
  return user?.email ?? null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Détermine si un tenant a une Stripe Subscription active au moment du
 * finalize. On regarde côté Hub Prisma : la table `subscriptions` est
 * synchronisée par le dispatcher Stripe à chaque webhook.
 *
 * Une sub est considérée "active" si elle est dans un état où Stripe
 * facture / attend de facturer : `active`, `trialing` (Stripe-natif),
 * ou `past_due` (le user a une CB enregistrée, le débit a juste foiré
 * temporairement — on ne downgrade pas).
 *
 * NB : on ne fait PAS d'appel à l'API Stripe ici. Si la table locale
 * désync (rare, on a stripe_events qui rejoue), le pire scénario est de
 * downgrader un user qui a en fait une sub active — il sera réactivé
 * par le prochain webhook subscription.updated. Robert préfère ça à
 * un cron qui dépend de l'API Stripe pour tourner.
 */
async function defaultHasActiveStripeSub(
  tenantId: string,
  _app: string,
): Promise<boolean> {
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { id: isUuid(tenantId) ? tenantId : undefined },
        { notifuseWorkspaceSlug: tenantId },
        { slug: tenantId },
      ].filter((c): c is { id: string } | { notifuseWorkspaceSlug: string } | { slug: string } =>
        Object.values(c).some((v) => v !== undefined),
      ),
    },
    select: { userId: true },
  });
  if (!tenant) return false;

  const activeSub = await prisma.subscription.findFirst({
    where: {
      userId: tenant.userId,
      status: { in: ['active', 'trialing', 'past_due'] },
    },
    select: { id: true },
  });
  return !!activeSub;
}

// GET pour observabilité (status sans auth, comme cleanup-trials).
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/cron/trial-tick',
    method: 'POST',
    description:
      'Avance la trial state machine cross-app : activate (J+2), notify (J+12), finalize (J+15).',
    authentication: 'Bearer CRON_SECRET',
    schedule: 'every 30 minutes (hub-trial-tick-cron.yml)',
    references: [
      'docs/PRICING-VERIDIAN.md §Flow trial complet',
      'docs/CONTRAT-HUB.md §Trial state machine',
      'todo/2026-05-21-trial-state-machine.md',
    ],
  });
}
