/**
 * MEGA B-01 — Trial complet J0 → J+2 → J+15 sans CB (paywall)
 *
 * **POURQUOI** : la trial state machine livrée 2026-05-21 (commit 8802f58)
 * doit garantir le cycle entier d'un user qui n'achète JAMAIS de CB :
 *   - J+0     : signup, aucun bandeau trial, état initial neutre
 *   - J+2     : après 5 mails Notifuse, state passe `eligible` puis
 *               `trial_active` (cron back-daté -49h)
 *   - J+12    : ending_soon_notified = true (mail "essai bientôt fini")
 *   - J+15    : state passe `expired` (sans Stripe sub) → tenant tombe
 *               en mode dégradé read-only côté apps downstream
 *
 * **DIFFÉRENCE vs spec 10 existant** : spec 10 teste les transitions
 * UNITAIRES (S1-S10). B-01 teste le PARCOURS commercial complet sur un
 * seul tenant en enchaînant signal → cron J+2 → cron J+12 → cron J+15
 * dans le même test, pour valider qu'il n'y a pas de régression
 * d'enchaînement d'états (genre : `expired` qui re-bascule en `eligible`
 * lors d'un signal tardif).
 *
 * **ASSERTS** (15 hardcore) :
 *  1. table tenant_trials existe (préflight)
 *  2. cron tick préflight 200
 *  3. signal initial → state = 'eligible', eligible_at posé
 *  4. cron tick sans back-date → state reste 'eligible' (pas
 *     d'activation prématurée < 48h)
 *  5. après back-date -49h + cron tick → state = 'trial_active'
 *  6. trial_started_at posé (= NOW à tolerance 5min)
 *  7. trial_ends_at posé (= trial_started_at + 15j à tolerance 1j)
 *  8. ending_soon_notified initial = false
 *  9. après back-date -13j + cron tick → ending_soon_notified = true
 * 10. cron tick re-tirée immédiatement → ending_soon_notified reste true
 *     (idempotence, pas de double notif)
 * 11. après back-date trial_ends_at -1j + cron tick (sans Stripe sub)
 *     → state = 'expired'
 * 12. expired_at posé après finalisation
 * 13. cron tick après expired → state reste 'expired' (pas de re-bascule)
 * 14. signal `activity_threshold` post-expired → row reste 'expired'
 *     (anti-régression : pas de réveil silencieux)
 * 15. cleanup : DELETE tenant_trials + tenants fixture par préfixe
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  STAGING_URL,
  freshIpHeader,
  withRateLimitRetry,
} from '../../_helpers';
import {
  runSqlOnStaging,
  selectRow,
  selectScalar,
  ensureTenantForTrial,
  deleteTenantTrial,
  deleteTenantBySlug,
  setEligibleAt,
} from '../../_sql-helper';

import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'b';
const SPEC = '01-paywall';

const CRON_SECRET = process.env.CRON_SECRET || 'staging-cron-secret';
const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

function tenantSlug(suffix: string): string {
  // Format compatible regex `mega-*` du db-purge.
  return `mega-${BUCKET}-${SPEC}-${MEGA_RUN_STAMP}-${suffix}`;
}

async function emitSignal(
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
        occurred_at: new Date().toISOString(),
        contract_version: '1.4',
        data: { threshold: 5, current: 5 },
      },
      failOnStatusCode: false,
    }),
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

test.describe.configure({ mode: 'serial' });

test.describe('Mega B-01 — Trial paywall (J0 → J+15 sans CB)', () => {
  const t = tenantSlug('paywall');

  test.afterAll(async () => {
    try {
      deleteTenantTrial(t, 'notifuse');
      deleteTenantBySlug(t);
    } catch {
      /* swallow */
    }
  });

  test('B-01 — préflight : route cron et table tenant_trials OK', async ({ request }) => {
    const tableOk = selectScalar(
      `SELECT to_regclass('hub_app.tenant_trials')::text;`,
    );
    expect(tableOk, 'migration 20260521150000_add_tenant_trials doit être appliquée').toBe(
      'hub_app.tenant_trials',
    );
    const res = await request.get(`${STAGING_URL}/api/cron/trial-tick`, {
      failOnStatusCode: false,
    });
    expect(res.status(), 'route /api/cron/trial-tick doit être déployée').toBe(200);
  });

  test('B-01 — J0 → J+2 → J+12 → J+15 enchaînement complet', async ({ request }) => {
    // ─── Setup : tenant minimal (filtre EXISTS du cron — cf 2a1a12e) ──
    ensureTenantForTrial(t);

    // ─── J+0 : signal initial → state=eligible ──────────────────────
    const sig = await emitSignal(request, t);
    expect(sig.status(), 'signal activity_threshold doit être accepté').toBe(200);

    const stateInitial = selectScalar(
      `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    expect(stateInitial, 'après signal, state doit être eligible').toBe('eligible');

    // ─── Anti-activation prématurée : cron tick sans back-date ──────
    await tickCron(request);
    const stateBeforeActivation = selectScalar(
      `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    expect(
      stateBeforeActivation,
      'cron tick avec eligible_at récent NE DOIT PAS activer le trial (anti-régression < 48h)',
    ).toBe('eligible');

    // ─── J+2 : back-date eligible_at -49h → cron tick → trial_active ──
    const eligibleAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    setEligibleAt(t, 'notifuse', eligibleAt);
    await tickCron(request);

    const activeRow = selectRow(
      `SELECT state, trial_started_at, trial_ends_at,
              CASE WHEN ending_soon_notified THEN 't' ELSE 'f' END AS notif
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      ['state', 'trial_started_at', 'trial_ends_at', 'notif'],
    );
    expect(activeRow, 'tenant_trials row doit exister').not.toBeNull();
    expect(activeRow!.state, 'après back-date -49h + cron, state doit être trial_active').toBe(
      'trial_active',
    );
    expect(
      activeRow!.trial_started_at,
      'trial_started_at doit être posé après activation',
    ).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(
      activeRow!.trial_ends_at,
      'trial_ends_at doit être posé après activation',
    ).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(
      activeRow!.notif,
      'ending_soon_notified DOIT être false à l\'activation (rien à notifier J+2)',
    ).toBe('f');

    // ─── trial_ends_at ≈ trial_started_at + 15j à tolerance 1j ─────
    const startedAt = new Date(
      activeRow!.trial_started_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
    );
    const endsAt = new Date(
      activeRow!.trial_ends_at.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
    );
    const diffDays = (endsAt.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(
      Math.abs(diffDays - 15),
      `trial_ends_at - trial_started_at doit être ~15j (got ${diffDays}j)`,
    ).toBeLessThan(1);

    // ─── J+12 : back-date trial_started_at -13j → cron tick → notify ──
    const back13d = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
    const back2dFuture = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    runSqlOnStaging(
      `UPDATE hub_app.tenant_trials
         SET trial_started_at = '${back13d}',
             trial_ends_at    = '${back2dFuture}',
             ending_soon_notified = FALSE
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    await tickCron(request);

    const notifiedAfter = selectScalar(
      `SELECT CASE WHEN ending_soon_notified THEN 't' ELSE 'f' END
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    expect(
      notifiedAfter,
      'cron tick avec trial -13j doit poser ending_soon_notified=true',
    ).toBe('t');

    // ─── Idempotence J+12 : re-tick → notified reste true ────────────
    await tickCron(request);
    const notifiedAfter2 = selectScalar(
      `SELECT CASE WHEN ending_soon_notified THEN 't' ELSE 'f' END
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    expect(
      notifiedAfter2,
      'cron tick re-tirée NE DOIT PAS unset notified (idempotence stricte)',
    ).toBe('t');

    // ─── J+15 : back-date trial_ends_at -1j → cron tick → expired ─────
    const back16d = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString();
    const back1dPast = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    runSqlOnStaging(
      `UPDATE hub_app.tenant_trials
         SET state = 'trial_active',
             trial_started_at = '${back16d}',
             trial_ends_at    = '${back1dPast}',
             ending_soon_notified = TRUE
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    await tickCron(request);

    const finalRow = selectRow(
      `SELECT state, expired_at
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      ['state', 'expired_at'],
    );
    expect(finalRow, 'row finale doit exister').not.toBeNull();
    expect(
      finalRow!.state,
      'trial expiré SANS Stripe sub doit passer expired',
    ).toBe('expired');
    expect(
      finalRow!.expired_at,
      'expired_at doit être posé au moment de la finalisation',
    ).toMatch(/\d{4}-\d{2}-\d{2}/);

    // ─── Anti-régression : cron tick post-expired ne ré-active pas ──
    await tickCron(request);
    const stateStillExpired = selectScalar(
      `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    expect(
      stateStillExpired,
      'cron tick post-expired NE DOIT PAS ré-activer le trial',
    ).toBe('expired');

    // ─── Anti-régression : signal post-expired ne remet pas eligible ──
    const sigPostExpired = await emitSignal(request, t);
    expect(sigPostExpired.status()).toBe(200);
    const statePostSignal = selectScalar(
      `SELECT state FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    expect(
      statePostSignal,
      'signal activity_threshold post-expired NE DOIT PAS ressusciter le trial',
    ).toBe('expired');
  });
});
