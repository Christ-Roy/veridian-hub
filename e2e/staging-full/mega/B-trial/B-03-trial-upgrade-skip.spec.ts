/**
 * MEGA B-03 — Trial active → upgrade direct (skip trial)
 *
 * **POURQUOI** : un user en plein trial qui ne veut pas attendre les 15j
 * doit pouvoir upgrade direct en Pro. Le state machine doit alors :
 *   - passer immédiatement `trial_active` → `converted`
 *   - ne plus afficher AUCUN bandeau trial côté UI
 *   - cesser tout processing par le cron (no-op sur state=converted)
 *
 * **STRATÉGIE** : on simule par SQL l'effet de l'upgrade (UPDATE state =
 * 'converted' avec dates trial actives non-expirées). On valide ensuite
 * que le cron NE TOUCHE PAS à cette row (idempotence forte), même s'il
 * est tiré plusieurs fois en cours d'éligibilité du trial.
 *
 * **ASSERTS** (10 hardcore) :
 *  1. tenant fixture + row tenant_trials trial_active insérés
 *  2. UPDATE state → converted (simulant upgrade direct user)
 *  3. trial_started_at + trial_ends_at conservés (audit trail)
 *  4. ending_soon_notified = false reste false
 *  5. cron tick 1 → state reste converted
 *  6. cron tick 2 → state reste converted (idempotence forte)
 *  7. cron tick 3 (avec back-date trial_started_at -13j artificiel) →
 *     state reste converted (le cron NE DOIT PAS notifier ending_soon
 *     sur converted)
 *  8. ending_soon_notified reste false après les 3 ticks
 *  9. expired_at reste NULL (sémantique converted ≠ expired)
 * 10. cleanup propre
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

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
} from '../../_sql-helper';

import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'b';
const SPEC = '03-upgrade';

const CRON_SECRET = process.env.CRON_SECRET || 'staging-cron-secret';

function tenantSlug(suffix: string): string {
  return `mega-${BUCKET}-${SPEC}-${MEGA_RUN_STAMP}-${suffix}`;
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

test.describe('Mega B-03 — Trial active → upgrade direct (skip trial)', () => {
  const t = tenantSlug('upgrade');

  test.afterAll(async () => {
    try {
      deleteTenantTrial(t, 'notifuse');
      deleteTenantBySlug(t);
    } catch {
      /* swallow */
    }
  });

  test('B-03 — upgrade J+5 → converted ne re-bascule jamais', async ({ request }) => {
    // Setup : tenant + row trial_active J+5 (5 jours après début, 10 jours
    // restants en théorie).
    ensureTenantForTrial(t);

    const startedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const endsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    runSqlOnStaging(
      `INSERT INTO hub_app.tenant_trials
         (tenant_id, app, state, eligible_at,
          trial_started_at, trial_ends_at, ending_soon_notified)
       VALUES (
         '${t}',
         'notifuse',
         'trial_active',
         '${startedAt}',
         '${startedAt}',
         '${endsAt}',
         FALSE
       )
       ON CONFLICT (tenant_id, app) DO UPDATE SET
         state = 'trial_active',
         trial_started_at = EXCLUDED.trial_started_at,
         trial_ends_at = EXCLUDED.trial_ends_at,
         ending_soon_notified = FALSE,
         expired_at = NULL;`,
    );

    // ─── Simule l'effet de l'upgrade direct : UPDATE state → converted ─
    runSqlOnStaging(
      `UPDATE hub_app.tenant_trials
         SET state = 'converted'
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );

    // ─── Vérifier les invariants après "upgrade" ─────────────────────
    const afterUpgrade = selectRow(
      `SELECT state,
              CASE WHEN ending_soon_notified THEN 't' ELSE 'f' END AS notif,
              COALESCE(expired_at::text, '') AS expired,
              trial_started_at,
              trial_ends_at
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      ['state', 'notif', 'expired', 'trial_started_at', 'trial_ends_at'],
    );
    expect(afterUpgrade!.state, 'state doit être converted après upgrade').toBe('converted');
    expect(afterUpgrade!.notif, 'pas de notif J+12 sur trial converted').toBe('f');
    expect(afterUpgrade!.expired, 'expired_at NULL : converted ≠ expired').toBe('');
    expect(
      afterUpgrade!.trial_started_at,
      'trial_started_at conservé pour audit',
    ).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(
      afterUpgrade!.trial_ends_at,
      'trial_ends_at conservé pour audit (mais ignoré par le cron sur converted)',
    ).toMatch(/\d{4}-\d{2}-\d{2}/);

    // ─── 3 ticks cron consécutifs → state reste converted ────────────
    for (let i = 0; i < 3; i++) {
      const res = await tickCron(request);
      expect(res.status(), `tick ${i + 1} doit retourner 200`).toBe(200);

      const state = selectScalar(
        `SELECT state FROM hub_app.tenant_trials
           WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        state,
        `cron tick ${i + 1} sur converted NE DOIT PAS bouger l'état`,
      ).toBe('converted');
    }

    // ─── Stress test : back-date trial_started_at -13j → cron tick ──
    // Même avec une row qui ressemble à un "ending soon" si on regardait
    // les dates, le cron NE DOIT PAS toucher à un tenant converted.
    const back13d = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
    const back2dFuture = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    runSqlOnStaging(
      `UPDATE hub_app.tenant_trials
         SET trial_started_at = '${back13d}',
             trial_ends_at = '${back2dFuture}'
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
    );
    await tickCron(request);

    const stressed = selectRow(
      `SELECT state,
              CASE WHEN ending_soon_notified THEN 't' ELSE 'f' END AS notif
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      ['state', 'notif'],
    );
    expect(
      stressed!.state,
      'cron tick avec dates "ending soon" sur converted : état inchangé',
    ).toBe('converted');
    expect(
      stressed!.notif,
      'ending_soon_notified DOIT rester false sur converted (anti-régression : pas de mail trial post-upgrade)',
    ).toBe('f');
  });
});
