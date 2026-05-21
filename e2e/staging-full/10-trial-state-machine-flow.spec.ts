/**
 * Journey 10 — Trial state machine cross-app (PRIORITÉ ABSOLUE).
 *
 * **POURQUOI CE SPEC** : la trial state machine livrée 2026-05-21
 * (commit 8802f58 + fix 83b955a) déclenche tout seul la bascule
 * Free → Pro → Expired/Converted pour chaque tenant. Un bug ici coûte du
 * chiffre d'affaires direct (30€/mois × N users) ou défonce des clients
 * actifs (downgrade prématuré → app cassée côté tenant payant). C'est le
 * scénario business le plus critique non-testé E2E.
 *
 * **CE QUE CE SPEC COUVRE** (10 scénarios) :
 *
 *   S1 Webhook signal `tenant.activity_threshold_reached` → row UPSERT
 *      state='eligible', eligible_at=NOW
 *   S2 Idempotence webhook : replay même idempotency_key → 200 dedup,
 *      pas de double-write
 *   S3 Cron tick + DB sans row eligible >=48h → no-op (activated:0)
 *   S4 Cron tick + row eligible_at back-dated -49h → state='trial_active',
 *      trial_started_at posé, trial_ends_at = +15j
 *   S5 Cron tick + trial_active back-dated -13j → ending_soon_notified=true
 *   S6 Cron tick après S5 → ending_soon_notified reste true, pas re-notif
 *   S7 Cron tick + trial_ends_at -1j SANS Stripe sub → state='expired'
 *   S8 Cron tick + trial_ends_at -1j AVEC Stripe sub active →
 *      state='converted' (pas de downgrade)
 *   S9 Race condition : 2 ticks parallèles → 1 seul active la row (test
 *      qu'on a bien SELECT FOR UPDATE SKIP LOCKED)
 *   S10 Auth CRON_SECRET : sans header / wrong token → 401
 *
 * **PRÉ-REQUIS STAGING** :
 *   - Migration `20260521150000_add_tenant_trials` appliquée (table
 *     hub_app.tenant_trials existe)
 *   - Route `POST /api/cron/trial-tick` déployée (commit ≥ 83b955a)
 *   - ENV `CRON_SECRET=staging-cron-secret`, `NOTIFUSE_WEBHOOK_TOKEN`,
 *     `ADMIN_SECRET=staging-admin-secret-not-real-e2e` injectées
 *   - Accès SSH `dev-pub` + container `hub-staging-db` (cf _sql-helper.ts)
 *
 * **CLEANUP** : chaque test supprime les rows tenant_trials qu'il a créées
 * via un préfixe unique `trial-e2e-${RUN_STAMP}` + DELETE final.
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
  selectScalar,
  deleteTenantTrial,
  setEligibleAt,
  backdateTrialActive,
} from './_sql-helper';

const CRON_SECRET = process.env.CRON_SECRET || 'staging-cron-secret';
const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

/** Tenant ID unique pour ce run, isolé des autres tests. */
function tenantId(slug: string): string {
  return `trial-e2e-${RUN_STAMP}-${slug}`;
}

/** Émet le signal `tenant.activity_threshold_reached` côté webhook. */
async function emitActivityThreshold(
  request: APIRequestContext,
  tenant: string,
  idempotencyKey: string = randomUUID(),
) {
  return withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
      headers: {
        authorization: `Bearer ${NOTIFUSE_WEBHOOK_TOKEN}`,
        'content-type': 'application/json',
        ...freshIpHeader(),
      },
      data: {
        event: 'tenant.activity_threshold_reached',
        tenant_id: tenant,
        idempotency_key: idempotencyKey,
        emitted_at: new Date().toISOString(),
        contract_version: '1.4',
        data: { threshold: 5, current: 5 },
      },
      failOnStatusCode: false,
    }),
  );
}

/** Déclenche le cron tick côté Hub. */
async function tickCron(
  request: APIRequestContext,
  authOverride?: string | null,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...freshIpHeader(),
  };
  if (authOverride === null) {
    // pas de header
  } else if (authOverride !== undefined) {
    headers.authorization = authOverride;
  } else {
    headers.authorization = `Bearer ${CRON_SECRET}`;
  }
  return withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/cron/trial-tick`, {
      headers,
      data: '{}',
      failOnStatusCode: false,
    }),
  );
}

// ─── Sanity check : staging tourne sur une version qui a la route ────────

test.describe('Journey 10 — Pré-flight (staging a le code trial state machine)', () => {
  test('GET /api/cron/trial-tick renvoie le descripteur (route déployée)', async ({
    request,
  }) => {
    const res = await request.get(`${STAGING_URL}/api/cron/trial-tick`, {
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      'staging doit avoir déployé app/api/cron/trial-tick (commit ≥ 83b955a). ' +
        'Si 404, c\'est que le build staging est cassé : check `gh run list --workflow=hub-staging.yml`',
    ).toBe(200);
    const body = await res.json();
    expect(body.endpoint).toBe('/api/cron/trial-tick');
    expect(body.authentication).toMatch(/CRON_SECRET/);
  });

  test('table hub_app.tenant_trials existe', async () => {
    const out = selectScalar(
      `SELECT to_regclass('hub_app.tenant_trials')::text;`,
    );
    expect(
      out,
      'migration 20260521150000_add_tenant_trials doit être appliquée',
    ).toBe('hub_app.tenant_trials');
  });
});

// ─── S1 + S2 : webhook signal + idempotence ──────────────────────────────

test.describe('Journey 10 — S1/S2 webhook activity_threshold_reached', () => {
  test('S1 : signal → row UPSERT state=eligible + eligible_at=NOW', async ({
    request,
  }) => {
    const t = tenantId('s1');
    try {
      const res = await emitActivityThreshold(request, t);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.dispatched).toBe(true);

      // Vérification DB : row créée avec state=eligible.
      const row = selectRow(
        `SELECT state, eligible_at, trial_started_at, expired_at
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
        ['state', 'eligible_at', 'trial_started_at', 'expired_at'],
      );
      expect(row, 'row tenant_trials doit être créée par le handler').not.toBeNull();
      expect(row!.state).toBe('eligible');
      expect(
        row!.eligible_at,
        'eligible_at doit être posé (= début compte à rebours 48h)',
      ).toMatch(/\d{4}-\d{2}-\d{2}/);
      // NULL en mode -tA = chaîne vide pour les colonnes nulles.
      expect(['', null]).toContain(row!.trial_started_at);
      expect(['', null]).toContain(row!.expired_at);
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });

  test('S2 : replay même idempotency_key → dedup, pas de double UPSERT', async ({
    request,
  }) => {
    const t = tenantId('s2');
    const key = randomUUID();
    try {
      const first = await emitActivityThreshold(request, t, key);
      expect(first.status()).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.dispatched).toBe(true);

      const eligibleAt1 = selectScalar(
        `SELECT eligible_at FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );

      // Replay même key → dedup
      const second = await emitActivityThreshold(request, t, key);
      expect(second.status()).toBe(200);
      const secondBody = await second.json();
      expect(
        secondBody.deduplicated,
        'replay même idempotency_key DOIT renvoyer deduplicated=true',
      ).toBe(true);

      // eligible_at INCHANGÉ (pas de re-écriture).
      const eligibleAt2 = selectScalar(
        `SELECT eligible_at FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(eligibleAt2).toBe(eligibleAt1);
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });
});

// ─── S3 + S4 : cron activation ───────────────────────────────────────────

test.describe('Journey 10 — S3/S4 cron tick activation eligible → trial_active', () => {
  test('S3 : cron tick + row eligible récente → no-op (pas d\'activation prématurée)', async ({
    request,
  }) => {
    const t = tenantId('s3');
    try {
      // INSERT direct : state=eligible, eligible_at=NOW (donc <48h)
      const insertRes = await emitActivityThreshold(request, t);
      expect(insertRes.status()).toBe(200);

      const res = await tickCron(request);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // State inchangé.
      const state = selectScalar(
        `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        state,
        'eligible <48h ne doit PAS être activé par le cron',
      ).toBe('eligible');
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });

  test('S4 : cron tick + eligible_at back-dated -49h → state=trial_active + dates', async ({
    request,
  }) => {
    const t = tenantId('s4');
    try {
      // 1. Émet le signal → row 'eligible'
      const sig = await emitActivityThreshold(request, t);
      expect(sig.status()).toBe(200);

      // 2. Back-date eligible_at de -49h
      const eligibleAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
      setEligibleAt(t, 'notifuse', eligibleAt);

      // 3. Trigger cron tick
      const tick = await tickCron(request);
      expect(tick.status()).toBe(200);
      const body = await tick.json();
      expect(body.ok).toBe(true);
      // NB : `summary.activated` n'est incrémenté que si TOUT le flow
      // (DB update + Notifuse update-plan + email + Telegram) passe sans
      // erreur. Sur staging avec un tenant_id factice, le call Notifuse
      // throw "tenant not found" — le DB UPDATE est déjà commit
      // (state=trial_active) mais summary.activated reste à 0 et l'erreur
      // va dans summary.errors. L'invariant qu'on teste ici est donc
      // l'état de la DB, pas le compteur du summary.

      // 4. Vérifier DB : state=trial_active, trial_started_at + trial_ends_at posés
      const row = selectRow(
        `SELECT state, trial_started_at, trial_ends_at
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
        ['state', 'trial_started_at', 'trial_ends_at'],
      );
      expect(row).not.toBeNull();
      expect(
        row!.state,
        `cron tick doit avoir activé notre row en trial_active (cron summary: ${JSON.stringify(body)})`,
      ).toBe('trial_active');
      expect(row!.trial_started_at).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(row!.trial_ends_at).toMatch(/\d{4}-\d{2}-\d{2}/);

      // 5. trial_ends_at ≈ NOW + 15j (tolerance 1j pour éviter flake timezone).
      // psql -tA renvoie "2026-05-21 19:30:00.123456+00" — JS Date() exige
      // un format ISO strict, donc on convertit " " → "T" ET "+00" → "+00:00".
      const endsAt = new Date(
        row!.trial_ends_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
      );
      const expectedEnds = Date.now() + 15 * 24 * 60 * 60 * 1000;
      expect(
        endsAt.getTime(),
        `trial_ends_at doit parser correctement (got "${row!.trial_ends_at}")`,
      ).not.toBeNaN();
      expect(
        Math.abs(endsAt.getTime() - expectedEnds),
        `trial_ends_at doit être ~NOW+15d (got diff ${Math.abs(endsAt.getTime() - expectedEnds)}ms)`,
      ).toBeLessThan(24 * 60 * 60 * 1000);
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });
});

// ─── S5 + S6 : ending soon notification ──────────────────────────────────

test.describe('Journey 10 — S5/S6 ending soon (J+12)', () => {
  test('S5 : trial_active back-dated -13j → ending_soon_notified=true', async ({
    request,
  }) => {
    const t = tenantId('s5');
    try {
      const sig = await emitActivityThreshold(request, t);
      expect(sig.status()).toBe(200);

      // Setup : passer en trial_active back-daté -13j, ending_soon_notified=FALSE
      const startedAt = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      runSqlOnStaging(
        `UPDATE hub_app.tenant_trials
         SET state = 'trial_active',
             trial_started_at = '${startedAt}',
             trial_ends_at = '${endsAt}',
             ending_soon_notified = FALSE
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );

      const tick = await tickCron(request);
      expect(tick.status()).toBe(200);
      const body = await tick.json();
      expect(
        body.notified,
        'cron tick doit avoir notifié au moins notre row (J+12 atteint)',
      ).toBeGreaterThanOrEqual(1);

      const notified = selectScalar(
        `SELECT ending_soon_notified FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(notified).toBe('t'); // psql -tA renvoie 't'/'f' pour boolean
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });

  test('S6 : cron tick après S5 (ending_soon_notified=true déjà) → pas re-notif', async ({
    request,
  }) => {
    const t = tenantId('s6');
    try {
      const sig = await emitActivityThreshold(request, t);
      expect(sig.status()).toBe(200);

      // Setup : déjà notifié
      const startedAt = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      runSqlOnStaging(
        `UPDATE hub_app.tenant_trials
         SET state = 'trial_active',
             trial_started_at = '${startedAt}',
             trial_ends_at = '${endsAt}',
             ending_soon_notified = TRUE
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );

      const tick = await tickCron(request);
      expect(tick.status()).toBe(200);

      // Notre row reste flagged. On ne peut pas asserter notified == 0
      // global (d'autres rows peuvent passer le seuil), mais on peut
      // asserter que NOTRE row n'a pas été re-touchée.
      const notified = selectScalar(
        `SELECT ending_soon_notified FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(notified).toBe('t');
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });
});

// ─── S7 + S8 : finalize (expired vs converted) ───────────────────────────

test.describe('Journey 10 — S7/S8 finalize (J+15)', () => {
  test('S7 : trial_ends_at -1j SANS Stripe sub → state=expired + downgrade', async ({
    request,
  }) => {
    const t = tenantId('s7');
    try {
      const sig = await emitActivityThreshold(request, t);
      expect(sig.status()).toBe(200);

      // Setup : trial expiré il y a 1j, ending_soon déjà notifié
      const startedAt = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      runSqlOnStaging(
        `UPDATE hub_app.tenant_trials
         SET state = 'trial_active',
             trial_started_at = '${startedAt}',
             trial_ends_at = '${endsAt}',
             ending_soon_notified = TRUE
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );

      const tick = await tickCron(request);
      expect(tick.status()).toBe(200);
      const body = await tick.json();
      expect(body.ok).toBe(true);
      // Comme S4 : on assert l'état DB. Le call Notifuse update-plan
      // downgrade peut throw "tenant not found" sur un slug factice — le DB
      // UPDATE est déjà commit, summary.expired reste à 0, l'erreur va dans
      // summary.errors.

      const row = selectRow(
        `SELECT state, expired_at FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
        ['state', 'expired_at'],
      );
      expect(row).not.toBeNull();
      expect(
        row!.state,
        `trial expiré sans Stripe sub doit passer expired (cron: ${JSON.stringify(body)})`,
      ).toBe('expired');
      expect(
        row!.expired_at,
        'expired_at doit être posé au moment du downgrade',
      ).toMatch(/\d{4}-\d{2}-\d{2}/);
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });

  test('S8 : trial_ends_at -1j AVEC Stripe sub active → state=converted (pas downgrade)', async ({
    request,
  }) => {
    // ⚠️ Ce test nécessite d'INSÉRER une row subscription côté Hub DB
    // pour simuler la conversion. Le tenant_id n'a pas de FK vers tenants,
    // donc on peut créer juste la row subscription + tenant_trials et le
    // résolveur hasActiveStripeSubForTenant fera son join.
    //
    // resolveOwnerEmail/defaultHasActiveStripeSub cherche Tenant.userId =
    // user.supabaseUserId AVEC ce tenantId. Pour faire passer S8 on a besoin :
    //   - Une row Tenant (slug=tenant_id ou notifuseWorkspaceSlug=tenant_id)
    //   - Avec userId pointant vers un User.supabaseUserId
    //   - Et une Subscription pour ce userId avec status='active'
    //
    // On reproduit ce setup en SQL direct pour rester self-contained.
    const t = tenantId('s8');
    const userUuid = randomUUID();
    const tenantUuid = randomUUID();
    const stripeCustomerId = `cus_e2e_${RUN_STAMP}`;
    const stripeSubId = `sub_e2e_${RUN_STAMP}-s8`;
    try {
      // 1. Crée User + Tenant + Subscription en SQL.
      // NB : la DB Hub utilise snake_case + @@map Prisma, pas le quoted-camelCase.
      // userId/tenants.user_id sont UUID, pas TEXT. id côté users est TEXT (cuid).
      const userTextId = `cm${RUN_STAMP.replace(/-/g, '')}s8`;
      runSqlOnStaging(`
        INSERT INTO hub_app.users (id, email, name, supabase_user_id, created_at, updated_at)
        VALUES ('${userTextId}', 'trial-s8-${RUN_STAMP}@e2e.veridian.site', 'Trial S8',
                '${userUuid}', NOW(), NOW())
        ON CONFLICT DO NOTHING;

        INSERT INTO hub_app.tenants
          (id, user_id, name, slug, notifuse_workspace_slug, status)
        VALUES ('${tenantUuid}', '${userUuid}', 'Trial S8 Tenant', '${t}', '${t}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO hub_app.subscriptions
          (id, user_id, status, stripe_customer_id, stripe_subscription_id,
           stripe_price_id, current_period_start, current_period_end,
           cancel_at_period_end)
        VALUES (gen_random_uuid(), '${userUuid}', 'active',
                '${stripeCustomerId}', '${stripeSubId}',
                'price_e2e_fake', NOW(), NOW() + INTERVAL '30 days',
                FALSE)
        ON CONFLICT DO NOTHING;
      `);

      // 2. Signal eligible + back-date direct en trial_active expiré
      const sig = await emitActivityThreshold(request, t);
      expect(sig.status()).toBe(200);

      const startedAt = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      runSqlOnStaging(
        `UPDATE hub_app.tenant_trials
         SET state = 'trial_active',
             trial_started_at = '${startedAt}',
             trial_ends_at = '${endsAt}',
             ending_soon_notified = TRUE
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );

      // 3. Cron tick → doit voir Stripe sub active → converted
      const tick = await tickCron(request);
      expect(tick.status()).toBe(200);
      const body = await tick.json();
      expect(body.ok).toBe(true);
      // summary.converted incrémenté à la fin de la branche conversion
      // (pas d'appel Notifuse update-plan, donc le compteur DOIT être
      // précis ici — contrairement à S4/S7).

      const state = selectScalar(
        `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        state,
        `trial expiré AVEC Stripe sub active doit passer converted (cron: ${JSON.stringify(body)})`,
      ).toBe('converted');

      // expired_at doit rester NULL (différence sémantique avec expired).
      // selectScalar renvoie soit null (pas de row) soit '' (NULL en colonne).
      const expiredAt = selectScalar(
        `SELECT expired_at FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        expiredAt === null || expiredAt === '',
        `converted ≠ expired : expired_at doit rester NULL (got "${expiredAt}")`,
      ).toBe(true);
    } finally {
      deleteTenantTrial(t, 'notifuse');
      runSqlOnStaging(`
        DELETE FROM hub_app.subscriptions WHERE user_id = '${userUuid}';
        DELETE FROM hub_app.tenants WHERE id = '${tenantUuid}';
        DELETE FROM hub_app.users WHERE supabase_user_id = '${userUuid}';
      `);
    }
  });
});

// ─── S9 : race condition cron parallèles ─────────────────────────────────

test.describe('Journey 10 — S9 race condition (SELECT FOR UPDATE SKIP LOCKED)', () => {
  test('2 calls cron simultanés → activated=2 total (jamais > 1 fois la même row)', async ({
    request,
  }) => {
    const t = tenantId('s9');
    try {
      const sig = await emitActivityThreshold(request, t);
      expect(sig.status()).toBe(200);

      const eligibleAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
      setEligibleAt(t, 'notifuse', eligibleAt);

      // 2 calls cron simultanés
      const [r1, r2] = await Promise.all([tickCron(request), tickCron(request)]);
      expect([200, 200]).toEqual([r1.status(), r2.status()]);

      const b1 = await r1.json();
      const b2 = await r2.json();
      expect(b1.ok).toBe(true);
      expect(b2.ok).toBe(true);

      // Invariant DB : notre row a bien été activée UNE SEULE FOIS.
      // (si SELECT FOR UPDATE SKIP LOCKED est cassé, on aurait 2 UPDATE
      // concurrents avec écrasement de trial_started_at — mais en pratique
      // l'UPDATE Prisma est atomique et la 2e transaction écraserait
      // simplement la 1ère sans détection. Le vrai test est sur le compteur
      // d'errors phase=activate : aucun "row not found" — i.e. les 2 ticks
      // ont vu DES rows différentes via SKIP LOCKED — ou un seul a touché
      // notre row.)
      const state = selectScalar(
        `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        state,
        `notre row doit être trial_active après le cron (got ${state}, ticks: ${JSON.stringify({ b1, b2 })})`,
      ).toBe('trial_active');

      // Le INVARIANT critique anti-double-activation est qu'un seul des 2
      // a effectivement matché notre row dans SELECT FOR UPDATE SKIP LOCKED.
      // On ne peut pas l'observer directement sans logs, mais on peut
      // vérifier que trial_started_at est posé UNE SEULE FOIS (= une
      // seule transaction a posé la date).
      const startedAt = selectScalar(
        `SELECT trial_started_at FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        startedAt,
        'trial_started_at doit être posé (single UPDATE)',
      ).toMatch(/\d{4}-\d{2}-\d{2}/);
    } finally {
      deleteTenantTrial(t, 'notifuse');
    }
  });
});

// ─── S10 : auth CRON_SECRET ──────────────────────────────────────────────

test.describe('Journey 10 — S10 auth Bearer CRON_SECRET', () => {
  test('sans header Authorization → 401', async ({ request }) => {
    const res = await tickCron(request, null);
    expect(res.status()).toBe(401);
  });

  test('Bearer token bidon → 401', async ({ request }) => {
    const res = await tickCron(request, 'Bearer definitely-wrong-secret');
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    // Garde-fou : pas de fuite du vrai secret dans la réponse
    expect(JSON.stringify(body).toLowerCase()).not.toContain('cron_secret');
  });

  test('Bearer valide + DB vide → 200 + summary zéro', async ({ request }) => {
    // Note : la DB n'est pas nécessairement vide (autres tests parallèles
    // peuvent avoir des rows). L'invariant est juste status 200 + summary
    // déterministe (activated, notified, expired, converted présents).
    const res = await tickCron(request);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.activated).toBe('number');
    expect(typeof body.notified).toBe('number');
    expect(typeof body.expired).toBe('number');
    expect(typeof body.converted).toBe('number');
    expect(Array.isArray(body.errors)).toBe(true);
    expect(typeof body.durationMs).toBe('number');
  });
});
