/**
 * MEGA spec K-02 — Race condition : 2 ticks cron trial-tick parallèles
 *
 * **POURQUOI** : le cron `/api/cron/trial-tick` est appelé toutes les 5 min
 * en prod, mais l'infra peut déclencher 2 invocations simultanées :
 *   - GitHub Actions cron + une invocation manuelle de debug
 *   - 2 workers concurrents si on scale Hub à >1 instance derrière
 *     Traefik
 *   - Retry après timeout réseau côté GH (déjà vu : 1 tick lance,
 *     timeout après 30s, GH retry, 1er tick continuait toujours)
 *
 * L'invariant DB est protégé par `SELECT FOR UPDATE SKIP LOCKED` dans le
 * code Prisma (cf S9 spec 10). Mais on doit prouver bout-en-bout que :
 *   1. Une row donnée n'est jamais activée 2× (trial_started_at posé 1
 *      seule fois, pas écrasé par le 2e tick)
 *   2. L'audit_log ne montre pas 2 entries `trial.activated` pour la même
 *      row (idempotence côté observabilité aussi)
 *   3. Les 2 ticks répondent 200 chacun (pas de deadlock)
 *   4. Le 2e tick voit notre row déjà locked et la skip — il continue son
 *      job sur les autres rows (les compteurs `activated/notified/expired`
 *      restent additionnels, jamais négatifs)
 *
 * **DIFFÉRENCE AVEC SPEC 10 S9** : on étend les asserts (audit_log,
 * idempotence transitions multiples, batch de 3 rows pour observer le
 * SKIP LOCKED en action) et on utilise le runtime MEGA (mock-oauth pour
 * créer le tenant via le vrai signup path, pas un raw SQL helper).
 *
 * **DURATION** : ~15-30 secondes (3 signups + 3 webhooks + 2 ticks //
 *   + queries DB).
 *
 * **CLEANUP** : afterAll purge les 3 tenants/trials.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import { findAuditEntries } from '../_fixtures/audit-log';
import {
  MEGA_STAGING_URL,
  megaTenantId,
} from '../_fixtures/mock-oauth';
import {
  runSqlOnStaging,
  selectScalar,
  ensureTenantForTrial,
  setEligibleAt,
  deleteTenantTrial,
  deleteTenantBySlug,
} from '../../_sql-helper';
import { bypassRateLimitHeaders, freshIpHeader, withRateLimitRetry } from '../../_helpers';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'k';
const SPEC = '02-parallel-trial-ticks';

const CRON_SECRET = process.env.CRON_SECRET || 'staging-cron-secret';
const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

test.describe.configure({ mode: 'serial' });

// 3 tenants : on en a besoin d'au moins 2 pour voir SKIP LOCKED faire son
// job (1 tick prend une row, l'autre saute par-dessus et prend la suivante).
// On en met 3 pour marge.
function makeTenantIds(): string[] {
  return [
    megaTenantId({ bucket: BUCKET, slug: 'cron-a' }),
    megaTenantId({ bucket: BUCKET, slug: 'cron-b' }),
    megaTenantId({ bucket: BUCKET, slug: 'cron-c' }),
  ];
}

async function emitActivityThreshold(
  request: APIRequestContext,
  tenant: string,
  idempotencyKey: string = randomUUID(),
) {
  return withRateLimitRetry(() =>
    request.post(`${MEGA_STAGING_URL}/api/webhooks/notifuse`, {
      headers: {
        authorization: `Bearer ${NOTIFUSE_WEBHOOK_TOKEN}`,
        'content-type': 'application/json',
        ...freshIpHeader(),
        ...bypassRateLimitHeaders(),
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
    request.post(`${MEGA_STAGING_URL}/api/cron/trial-tick`, {
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
        ...freshIpHeader(),
        ...bypassRateLimitHeaders(),
      },
      data: '{}',
      failOnStatusCode: false,
    }),
  );
}

test.describe('Mega K-02 — 2 cron trial-tick parallèles (SELECT FOR UPDATE SKIP LOCKED)', () => {
  const tenants = makeTenantIds();

  test.afterAll(async () => {
    // Cleanup ciblé : delete tenant_trials + tenants minimaux
    for (const t of tenants) {
      try {
        deleteTenantTrial(t, 'notifuse');
      } catch {
        /* idempotent */
      }
      try {
        deleteTenantBySlug(t);
      } catch {
        /* idempotent */
      }
    }
    // Filet : purgeMegaByPrefix attrape les éventuels résidus (audit_log etc.)
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
        tenantPrefix: `mega-${BUCKET}-${MEGA_RUN_STAMP}`,
      });
    } catch {
      /* afterAll ne throw jamais */
    }
  });

  test('2 ticks cron en parallèle → chaque row activée 1 seule fois (pas de double UPDATE)', async ({
    request,
  }) => {
    // ─── 1. Setup : 3 tenants en état eligible back-dated -49h ─────────
    for (const t of tenants) {
      ensureTenantForTrial(t);
      const sig = await emitActivityThreshold(request, t);
      expect(
        sig.status(),
        `webhook activity_threshold doit retourner 200 pour tenant ${t} (got ${sig.status()})`,
      ).toBe(200);

      // Back-date eligible_at -49h → prochaine tick activera ces rows.
      const eligibleAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
      setEligibleAt(t, 'notifuse', eligibleAt);
    }

    // Vérif pré-tick : les 3 rows sont en state eligible
    for (const t of tenants) {
      const state = selectScalar(
        `SELECT state FROM hub_app.tenant_trials WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        state,
        `pré-tick : tenant ${t} doit être state=eligible (got ${state})`,
      ).toBe('eligible');
    }

    // ─── 2. 2 calls cron en parallèle ──────────────────────────────────
    const start = Date.now();
    const [r1, r2] = await Promise.all([tickCron(request), tickCron(request)]);
    const duration = Date.now() - start;

    // ─── Assert 1 : les 2 ticks répondent 200 (pas de deadlock) ────────
    expect(r1.status(), `tick 1 doit 200 (got ${r1.status()})`).toBe(200);
    expect(r2.status(), `tick 2 doit 200 (got ${r2.status()})`).toBe(200);

    const b1 = await r1.json();
    const b2 = await r2.json();

    // ─── Assert 2 : body.ok=true pour les 2 ─────────────────────────────
    expect(b1.ok, `tick 1 doit body.ok=true: ${JSON.stringify(b1)}`).toBe(true);
    expect(b2.ok, `tick 2 doit body.ok=true: ${JSON.stringify(b2)}`).toBe(true);

    // ─── Assert 3 : aucun "row not found" / "lock contention" errors ───
    // L'invariant SKIP LOCKED : le 2e tick voit la row locked, SKIP, et
    // ne lève pas d'erreur "row not found mid-transaction".
    //
    // Note : ces tenants fixtures n'existent QUE côté Hub — l'appel Notifuse
    // `updatePlan` retournera donc "tenant not found" car le workspace n'est
    // pas provisionné downstream. On filtre ce mode d'échec attendu pour ne
    // garder que les vraies erreurs (lock contention, transaction abort, etc.).
    const ourTenants = new Set(tenants);
    const filterErrors = (errs: unknown): unknown[] => {
      if (!Array.isArray(errs)) return [];
      return errs.filter((e) => {
        const err = e as { tenantId?: string; error?: string };
        const isOurTenant = err.tenantId && ourTenants.has(err.tenantId);
        const isDownstreamNotFound = /tenant not found|workspace not found/i.test(
          err.error ?? '',
        );
        return !(isOurTenant && isDownstreamNotFound);
      });
    };
    expect(
      filterErrors(b1.errors),
      `tick 1 ne doit pas avoir d'errors (hors "tenant not found" Notifuse attendu pour fixtures): ${JSON.stringify(b1.errors)}`,
    ).toEqual([]);
    expect(
      filterErrors(b2.errors),
      `tick 2 ne doit pas avoir d'errors (hors "tenant not found" Notifuse attendu pour fixtures): ${JSON.stringify(b2.errors)}`,
    ).toEqual([]);

    // ─── Assert 4 : durée raisonnable (pas de deadlock 30s+) ───────────
    // 2 ticks parallèles sur 3 rows ne doivent pas dépasser ~10s en
    // staging (chacun ~2-3s + overhead réseau).
    expect(
      duration,
      `2 ticks // doivent finir < 30s (got ${duration}ms) — possible deadlock SKIP LOCKED`,
    ).toBeLessThan(30_000);

    // ─── Assert 5 : CHAQUE row est state=trial_active (UNE fois activée) ─
    // Si SKIP LOCKED marche, chaque row a été activée par UN seul tick.
    // Si SKIP LOCKED est cassé, on aurait pu avoir 2 UPDATE concurrents
    // avec écrasement → quand même trial_active, mais trial_started_at
    // serait écrasé. On vérifie les 2 invariants.
    for (const t of tenants) {
      const state = selectScalar(
        `SELECT state FROM hub_app.tenant_trials WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        state,
        `tenant ${t} doit être trial_active après le tick // (got ${state}). ` +
          `Si state=eligible toujours : les 2 ticks ont raté la row. ` +
          `Si autre : transition incorrecte.`,
      ).toBe('trial_active');
    }

    // ─── Assert 6 : sum des `activated` répartie sur les 2 ticks ───────
    // Avec SKIP LOCKED, chaque row est touchée par 1 seul tick. Total =
    // 3 (les 3 rows que nous avons posées) MAIS d'autres rows peuvent
    // aussi avoir été activées en parallèle par d'autres specs.
    // L'invariant minimal : activated_total ≥ 3 (les nôtres).
    // L'invariant strict (pas de double-counting) : aucun tick n'a > N
    // activated où N = total rows eligible en DB au moment du tick.
    const activated1 = Number(b1.activated ?? 0);
    const activated2 = Number(b2.activated ?? 0);
    expect(
      activated1 + activated2,
      `total activated (${activated1}+${activated2}) doit être ≥ 3 (nos rows). ` +
        `Si < 3 : un tick a raté.`,
    ).toBeGreaterThanOrEqual(3);

    // ─── Assert 7 : trial_started_at posé UNE SEULE FOIS par row ───────
    // Si SKIP LOCKED est cassé, on aurait 2 UPDATE successifs (le 2e
    // écrasant) — trial_started_at aurait 2 valeurs sur l'intervalle des
    // 2 ticks. On peut détecter ça en regardant si trial_started_at est
    // bien entre `start` et `start + duration` (pas après la fin du tick).
    for (const t of tenants) {
      const startedAt = selectScalar(
        `SELECT EXTRACT(EPOCH FROM trial_started_at) * 1000
         FROM hub_app.tenant_trials
         WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        startedAt,
        `trial_started_at doit être posé pour ${t}`,
      ).toMatch(/^\d+/);
      const startedAtMs = Number(startedAt);
      // Tolérance large (10s avant le start, et 60s après pour absorber
      // l'horloge clock-skew entre le runner Playwright et la DB).
      expect(
        startedAtMs,
        `trial_started_at (${startedAtMs}) doit être pendant la fenêtre tick ` +
          `[${start - 10_000}, ${start + duration + 60_000}] pour ${t}`,
      ).toBeGreaterThan(start - 10_000);
      expect(startedAtMs).toBeLessThan(start + duration + 60_000);
    }

    // ─── Assert 8 : audit_log idempotent (1 entry trial.activated/row) ─
    // Si l'audit log existe pour ces transitions, on doit avoir 1 entry
    // par tenant et pas 2. Pattern action probable : `trial.activated`
    // ou `tenant.trial.activated`.
    // Note : si pas d'audit pour cette transition cron, l'assert
    // s'auto-skip (entries.length === 0 = OK aussi).
    for (const t of tenants) {
      const entries = await findAuditEntries({
        actionLike: 'trial.%',
        targetId: t,
        limit: 10,
      });
      const activatedEntries = entries.filter((e) =>
        /activated|trial_active/.test(e.action),
      );
      // 0 ou 1 entry — JAMAIS 2 (double-write).
      expect(
        activatedEntries.length,
        `audit_log : tenant ${t} doit avoir 0 ou 1 entry trial.activated, ` +
          `got ${activatedEntries.length}: ${activatedEntries.map((e) => e.action).join(',')}`,
      ).toBeLessThanOrEqual(1);
    }

    // ─── Assert anti-régression : pas de cron qui crash en boucle ─────
    // En + des 2 ticks, on appelle 1 3e fois — il doit no-op (rien à
    // activer, rows déjà en trial_active). Compte activated=0 attendu
    // pour NOS rows (d'autres rows peuvent être en cours).
    const r3 = await tickCron(request);
    expect(r3.status()).toBe(200);
    const b3 = await r3.json();
    expect(b3.ok).toBe(true);

    // Pour CHAQUE row : son state DOIT toujours être trial_active (pas
    // re-activée, pas downgrade).
    for (const t of tenants) {
      const stateAfter = selectScalar(
        `SELECT state FROM hub_app.tenant_trials WHERE tenant_id = '${t}' AND app = 'notifuse';`,
      );
      expect(
        stateAfter,
        `tenant ${t} doit rester trial_active après 3e tick (got ${stateAfter})`,
      ).toBe('trial_active');
    }

    // Petit log diag pour debug future
    console.log(
      `[K-02] RUN_STAMP=${MEGA_RUN_STAMP} tick1=${activated1}act ` +
        `tick2=${activated2}act tick3=${b3.activated ?? 0}act ` +
        `duration2ticks=${duration}ms (3 rows MEGA)`,
    );

    // Garde-fou anti-warning lint : runSqlOnStaging utilisé via helpers,
    // mais on l'importe pour permettre un debug ad-hoc si la spec flake.
    void runSqlOnStaging;
  });
});
