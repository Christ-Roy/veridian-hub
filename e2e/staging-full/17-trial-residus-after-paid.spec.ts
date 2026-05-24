/**
 * Journey 17 — Anti-régression "client paie = plus aucune limite trial"
 *
 * **POURQUOI CE SPEC** : Robert exige que dès qu'un client paie (sub Stripe
 * active), AUCUN résidu trial ne subsiste — ni en DB, ni en mail, ni en UI.
 *
 * Le cron `processEndingSoon` avait une faille (livré 2026-05-24) :
 *   - Une row `tenant_trials` qui reste à `trial_active` alors que le user
 *     paie déjà → mail "ton essai expire dans 3j" parti à un payeur
 *
 * Fix appliqué :
 *   1. `utils/stripe/prisma-sync.ts` §1ter : purge proactive au webhook
 *      `subscription.created/updated` → `tenant_trials.state='converted'`
 *   2. `lib/trial/run-tick.ts:processEndingSoon` : défense en profondeur,
 *      skip + auto-purge si sub active détectée pendant le scan
 *
 * **CE QUE CE SPEC COUVRE** (3 scénarios) :
 *
 *   S1 : trial_active depuis 13j + sub Stripe active dans la DB →
 *        cron `trial-tick` doit purger à `converted` SANS marquer
 *        `ending_soon_notified=true` (i.e. aucun mail envoyé)
 *
 *   S2 : trial_active récent (<12j) + sub active → cron no-op (la row n'est
 *        pas dans la fenêtre scan, donc pas de purge par cron — c'est OK,
 *        elle sera purgée au prochain webhook subscription.updated, ou au
 *        cron quand elle entrera dans la fenêtre)
 *
 *   S3 : trial_active depuis 13j SANS sub Stripe → comportement normal
 *        (envoi prévu de l'email — on vérifie que `ending_soon_notified=true`
 *        passe bien, garde-fou que le fix n'a pas cassé le chemin nominal)
 *
 * **PRÉ-REQUIS STAGING** :
 *   - Mêmes que journey 10 (CRON_SECRET, container hub-staging-db)
 *   - Helpers SSH+SQL `_sql-helper.ts`
 *
 * **CLEANUP** : préfixe unique `paid-trial-e2e-${RUN_STAMP}` + DELETE final
 *   sur tenants + tenant_trials + subscriptions créées.
 *
 * Référence : `docs/AUDIT-TRIAL-RESIDUS-2026-05-24.md`,
 *             `todo/2026-05-23-audit-trial-residus-apres-paiement.md`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  STAGING_URL,
  RUN_STAMP,
  freshIpHeader,
  withRateLimitRetry,
} from './_helpers';
import {
  runSqlOnStaging,
  selectRow,
  deleteTenantTrial,
  backdateTrialActive,
  ensureTenantForTrial,
  deleteTenantBySlug,
} from './_sql-helper';

const CRON_SECRET = process.env.CRON_SECRET || 'staging-cron-secret';

/** Tenant ID unique pour ce run, isolé des autres tests. */
function tenantSlug(label: string): string {
  return `paid-trial-e2e-${RUN_STAMP}-${label}`;
}

/**
 * Insère une row `subscriptions` minimale en DB staging pour simuler un
 * user qui a payé. On bypass Stripe complètement — l'objectif est de tester
 * le comportement DOWNSTREAM (cron tick + purge tenant_trials), pas le
 * webhook Stripe lui-même (couvert par journey 09 + 12 + 14).
 *
 * Idempotent : ON CONFLICT (stripe_subscription_id) DO NOTHING.
 *
 * @param userId  UUID du user (doit matcher tenants.user_id)
 * @param label   suffixe unique (évite collision entre tests)
 */
function ensureActiveSubscriptionForUser(userId: string, label: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(userId) || !/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`ensureActiveSubscriptionForUser: unsafe identifier`);
  }
  const stripeSubId = `sub_e2e_${label}_${RUN_STAMP}`;
  const stripeCustId = `cus_e2e_${label}_${RUN_STAMP}`;
  runSqlOnStaging(
    `INSERT INTO hub_app.subscriptions
       (id, user_id, stripe_customer_id, stripe_subscription_id, status, plan_name)
     VALUES
       (gen_random_uuid(), '${userId}', '${stripeCustId}', '${stripeSubId}',
        'active', 'veridian-pro')
     ON CONFLICT (stripe_subscription_id) DO NOTHING;`,
  );
}

function deleteSubscriptionByLabel(label: string): void {
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`deleteSubscriptionByLabel: unsafe identifier`);
  }
  runSqlOnStaging(
    `DELETE FROM hub_app.subscriptions WHERE stripe_subscription_id = 'sub_e2e_${label}_${RUN_STAMP}';`,
  );
}

/**
 * Crée une row tenant_trials `trial_active` back-datée. Skippe le passage
 * webhook → on insère directement, car la création par webhook met
 * `state='eligible'` et on devrait simuler 48h + 12j supplémentaires.
 */
function insertTrialActive(tenantSlugValue: string, app: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(tenantSlugValue) || !/^[a-z]+$/.test(app)) {
    throw new Error(`insertTrialActive: unsafe identifier`);
  }
  const startedAt = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  runSqlOnStaging(
    `INSERT INTO hub_app.tenant_trials
       (tenant_id, app, state, eligible_at, trial_started_at, trial_ends_at)
     VALUES
       ('${tenantSlugValue}', '${app}', 'trial_active',
        '${startedAt}', '${startedAt}', '${endsAt}')
     ON CONFLICT (tenant_id, app) DO UPDATE
       SET state = 'trial_active',
           trial_started_at = '${startedAt}',
           trial_ends_at = '${endsAt}',
           ending_soon_notified = FALSE,
           updated_at = NOW();`,
  );
}

async function tickCron(request: APIRequestContext) {
  return withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/cron/trial-tick`, {
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
        ...freshIpHeader(),
      },
      data: '{}',
      failOnStatusCode: false,
    }),
  );
}

// ════════════════════════════════════════════════════════════════════════
// S1 — Anti-résidu : trial_active 13j + sub active → purge converted, no mail
// ════════════════════════════════════════════════════════════════════════

test.describe('Journey 17 — Anti-régression résidus trial après paiement', () => {
  test('S1 : tenant payeur en trial_active depuis 13j → cron purge converted SANS mail', async ({
    request,
  }) => {
    const slug = tenantSlug('s1');
    const subLabel = `s1-${randomUUID().slice(0, 8)}`;
    try {
      // 1. Crée le tenant minimal (récupère son user_id généré)
      ensureTenantForTrial(slug);
      const row = selectRow(
        `SELECT id::text AS id, user_id::text AS user_id
         FROM hub_app.tenants WHERE slug = '${slug}';`,
        ['id', 'user_id'],
      );
      expect(row, 'tenant doit être créé').not.toBeNull();
      const userId = row!.user_id;

      // 2. Insère une sub Stripe active pour ce user (bypass webhook)
      ensureActiveSubscriptionForUser(userId, subLabel);

      // 3. Insère une row tenant_trials state='trial_active' back-datée 13j
      //    (= dans la fenêtre du scan processEndingSoon)
      insertTrialActive(slug, 'notifuse');

      // 4. Trigger le cron — il doit détecter la row en scan, voir qu'il y
      //    a une sub active, et auto-corriger à 'converted' SANS marquer
      //    ending_soon_notified.
      const res = await tickCron(request);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // 5. Vérif DB : state='converted', ending_soon_notified=false
      const after = selectRow(
        `SELECT state, ending_soon_notified::text AS notified
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${slug}' AND app = 'notifuse';`,
        ['state', 'notified'],
      );
      expect(after, 'row toujours présente').not.toBeNull();
      expect(
        after!.state,
        'cron doit auto-corriger trial_active+sub-active → converted',
      ).toBe('converted');
      // PG `boolean::text` → 'true' / 'false' (pas 't' / 'f' qui serait le
      // formatage par défaut sans cast). Le cast est nécessaire car le mode
      // -tA de psql sépare par `|` et on a besoin d'un type prévisible.
      expect(
        after!.notified,
        'ending_soon_notified ne doit JAMAIS passer à true pour un payeur — sinon ça veut dire qu\'un mail "expire dans 3j" est parti à un client qui paie déjà',
      ).toBe('false');

      // 6. Sanity : summary du cron a incrémenté `converted`, PAS `notified`
      //    (on tolère que d'autres rows aient été notified, on regarde juste
      //    que converted > 0 si on a forcé une row).
      expect(
        body.converted,
        'summary.converted doit refléter au moins notre row purgée',
      ).toBeGreaterThanOrEqual(1);
    } finally {
      deleteTenantTrial(slug, 'notifuse');
      deleteSubscriptionByLabel(subLabel);
      deleteTenantBySlug(slug);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // S2 — Trial actif récent (<12j) + sub : pas dans la fenêtre scan, no-op
  // ══════════════════════════════════════════════════════════════════════

  test('S2 : trial_active récent (<12j) + sub → cron skip (pas dans fenêtre scan)', async ({
    request,
  }) => {
    const slug = tenantSlug('s2');
    const subLabel = `s2-${randomUUID().slice(0, 8)}`;
    try {
      ensureTenantForTrial(slug);
      const row = selectRow(
        `SELECT user_id::text AS user_id FROM hub_app.tenants WHERE slug = '${slug}';`,
        ['user_id'],
      );
      const userId = row!.user_id;
      ensureActiveSubscriptionForUser(userId, subLabel);

      // trial_active mais récent (5j) → hors fenêtre processEndingSoon (≥12j)
      // ET hors fenêtre processFinalize (trial_ends_at >12j dans le futur)
      const startedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
      runSqlOnStaging(
        `INSERT INTO hub_app.tenant_trials
           (tenant_id, app, state, eligible_at, trial_started_at, trial_ends_at)
         VALUES
           ('${slug}', 'notifuse', 'trial_active',
            '${startedAt}', '${startedAt}', '${endsAt}')
         ON CONFLICT (tenant_id, app) DO UPDATE
           SET state = 'trial_active', trial_started_at = '${startedAt}',
               trial_ends_at = '${endsAt}', ending_soon_notified = FALSE,
               updated_at = NOW();`,
      );

      // Backdate pour matcher le SQL exact du cron (cf run-tick.ts:302)
      backdateTrialActive(slug, 'notifuse', startedAt, endsAt);

      const res = await tickCron(request);
      expect(res.status()).toBe(200);

      // State inchangé : la row est hors fenêtre scan pour ce cron tick.
      // C'est OK — le prochain webhook subscription.updated ou un cron
      // ultérieur (quand elle entre dans la fenêtre) la purgera.
      const state = selectRow(
        `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${slug}' AND app = 'notifuse';`,
        ['state'],
      );
      expect(
        state!.state,
        'trial_active récent (<12j) ne doit pas être touché par ce cron tick',
      ).toBe('trial_active');
    } finally {
      deleteTenantTrial(slug, 'notifuse');
      deleteSubscriptionByLabel(subLabel);
      deleteTenantBySlug(slug);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // S3 — Garde-fou nominal : trial_active 13j SANS sub → notif normale
  // ══════════════════════════════════════════════════════════════════════

  test('S3 : trial_active 13j SANS sub → ending_soon_notified=true (chemin nominal préservé)', async ({
    request,
  }) => {
    const slug = tenantSlug('s3');
    try {
      ensureTenantForTrial(slug);
      // PAS de sub créée — c'est un user en trial qui n'a PAS payé.
      insertTrialActive(slug, 'notifuse');

      const res = await tickCron(request);
      expect(res.status()).toBe(200);

      // State reste trial_active, mais ending_soon_notified passe à true
      // (le cron a fait son boulot nominal d'envoi du mail "expire dans 3j").
      const after = selectRow(
        `SELECT state, ending_soon_notified::text AS notified
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${slug}' AND app = 'notifuse';`,
        ['state', 'notified'],
      );
      expect(after!.state).toBe('trial_active');
      // PG `boolean::text` → 'true' / 'false' (cf S1 ci-dessus).
      expect(
        after!.notified,
        'sans sub, le cron DOIT passer ending_soon_notified à true (chemin nominal)',
      ).toBe('true');
    } finally {
      deleteTenantTrial(slug, 'notifuse');
      deleteTenantBySlug(slug);
    }
  });
});
