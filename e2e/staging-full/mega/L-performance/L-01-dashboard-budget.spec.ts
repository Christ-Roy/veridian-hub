/**
 * MEGA spec L-01 — Performance budget : GET /dashboard (page authentifiée)
 *
 * **POURQUOI** : `/dashboard` est le hot path post-login. Toute lenteur ici
 * = client qui voit "ça rame" et churn. Budget réaliste pour staging
 * (cold cache, dev server partagé) :
 *   - p50 < 400ms (médiane, "feels snappy")
 *   - p95 < 1500ms (5e centile, "acceptable")
 *   - p99 < 3000ms (1e centile, "outlier toléré")
 *
 * On warm le cache d'abord (3 requests warmup ignorées) puis on mesure 100
 * GETs sériels. Sériel exprès pour ne pas saturer le dev server (qui n'a
 * pas le pool de connexions Postgres d'une prod).
 *
 * On teste AUSSI le cas non-authentifié (qui doit retourner 307 redirect
 * vers /login, et CE redirect doit être rapide aussi car c'est ce que
 * voient les bots/crawlers) — budget plus serré p95 < 500ms.
 *
 * **ASSERTS HARDCORE (8)** :
 *   1. Status 200 (cas authentifié) ou 307 (non-auth) sur 100% des samples
 *   2. p50 authentifié < 400ms +20% tolérance
 *   3. p95 authentifié < 1500ms +20%
 *   4. p99 authentifié < 3000ms +20%
 *   5. Aucun sample > 10s (timeout serveur)
 *   6. Mean / median ratio < 3 (distribution sans énorme skew)
 *   7. p95 non-auth (redirect) < 500ms +20% (hot path bots)
 *   8. Pas de 5xx (zéro tolérance)
 *
 * **DURATION** : ~30-60s (100 GETs sériels + 50 non-auth).
 *
 * **CLEANUP** : afterAll purge le user créé pour le test authentifié.
 */
import { test, expect } from '@playwright/test';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  disposeSession,
  megaSignIn,
  MEGA_STAGING_URL,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import {
  measure,
  assertBudget,
  computeStats,
} from '../_fixtures/perf-budget';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';
import { bypassRateLimitHeaders } from '../../_helpers';

const BUCKET = 'l';
const SPEC = '01-dashboard-budget';

// Budgets réalistes calibrés pour staging (dev server OVH 4 cores).
// Pour prod on aurait des chiffres ~3x plus stricts.
const BUDGET_DASHBOARD_AUTH = {
  p50: 400, // ms
  p95: 1500,
  p99: 3000,
  max: 10_000, // au-delà = crash/timeout
  tolerancePct: 20,
};
const BUDGET_DASHBOARD_REDIRECT = {
  p50: 200,
  p95: 500,
  p99: 1000,
  tolerancePct: 20,
};

const ITERATIONS_AUTH = 100;
const WARMUP_AUTH = 5;
const ITERATIONS_REDIRECT = 50;
const WARMUP_REDIRECT = 3;

test.describe.configure({ mode: 'serial' });

test.describe('Mega L-01 — Performance budget GET /dashboard', () => {
  let session: MegaSession | null = null;

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* afterAll ne throw jamais */
    }
  });

  test('GET /dashboard authentifié — 100 samples p50<400 / p95<1500 / p99<3000ms', async ({
    playwright,
  }) => {
    // ─── 1. Setup : user loggué via mock OAuth ─────────────────────────
    session = await megaSignIn(playwright as unknown as typeof import('@playwright/test'), {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
      variant: 'auth',
    });
    expect(session.callbackStatus).toBeLessThan(400);

    const req = session.request;
    const statuses: number[] = [];

    // ─── 2. Mesure : 100 GETs sériels (5 warmup + 95 samples) ──────────
    const stats = await measure({
      iterations: ITERATIONS_AUTH,
      warmup: WARMUP_AUTH,
      delayMs: 50, // anti-rate-limit, tolérable
      fn: async () => {
        const res = await req.get('/dashboard', {
          headers: bypassRateLimitHeaders(),
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        statuses.push(res.status());
        // Drain body pour assurer mesure complète (pas juste header time)
        await res.body().catch(() => undefined);
      },
    });

    console.log(
      `[L-01 auth] n=${stats.count} p50=${stats.p50.toFixed(0)} ` +
        `p95=${stats.p95.toFixed(0)} p99=${stats.p99.toFixed(0)} ` +
        `mean=${stats.mean.toFixed(0)} max=${stats.max.toFixed(0)} ` +
        `min=${stats.min.toFixed(0)} ms`,
    );

    // ─── Assert 1 : 100% des samples ont un status valide ─────────────
    // Authentifié → 200 (dashboard render) OU 307 (si la session a
    // expiré entre signup et 1ère mesure — improbable mais on tolère).
    const invalidStatuses = statuses.filter((s) => s !== 200 && s !== 307);
    expect(
      invalidStatuses.length,
      `Status invalides détectés (≠200/307) : ${invalidStatuses.slice(0, 5).join(',')}... ` +
        `Total ${invalidStatuses.length}/${statuses.length}. ` +
        `Premiers statuts : ${statuses.slice(0, 10).join(',')}`,
    ).toBe(0);

    // ─── Assert 2-4 : budgets p50/p95/p99 ─────────────────────────────
    assertBudget(stats, BUDGET_DASHBOARD_AUTH, 'GET /dashboard (auth)');

    // ─── Assert 5 : pas de sample > 10s (timeout serveur) ──────────────
    expect(
      stats.max,
      `Sample max ${stats.max.toFixed(0)}ms > 10s suggère un timeout serveur ou un crash.`,
    ).toBeLessThan(10_000);

    // ─── Assert 6 : distribution saine (mean/median < 3) ──────────────
    // Si mean >> median, on a une queue lourde (outliers). Acceptable
    // jusqu'à 3x. Au-delà = un endpoint a parfois 10x sa latence = bug.
    const skewRatio = stats.mean / Math.max(stats.p50, 1);
    expect(
      skewRatio,
      `Distribution skewed (mean/median=${skewRatio.toFixed(2)}, max=${stats.max.toFixed(0)}ms). ` +
        `Cherche un cold-path qui parfois explose la latence (cache miss, ` +
        `Prisma connection pool exhausted, etc.).`,
    ).toBeLessThan(3);

    // ─── Assert 8 : aucun 5xx absolu (zéro tolérance) ──────────────────
    const serverErrors = statuses.filter((s) => s >= 500);
    expect(
      serverErrors.length,
      `${serverErrors.length} 5xx détectés sur ${statuses.length} GETs ! ` +
        `Premiers : ${serverErrors.slice(0, 5).join(',')}. ` +
        `Hub crash sous charge légère = bug critique à fixer.`,
    ).toBe(0);
  });

  test('GET /dashboard non-auth (redirect) — 50 samples p95 < 500ms', async ({
    request,
  }) => {
    const statuses: number[] = [];

    const stats = await measure({
      iterations: ITERATIONS_REDIRECT,
      warmup: WARMUP_REDIRECT,
      delayMs: 30,
      fn: async () => {
        const res = await request.get(`${MEGA_STAGING_URL}/dashboard`, {
          headers: bypassRateLimitHeaders(),
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        statuses.push(res.status());
      },
    });

    console.log(
      `[L-01 redirect] n=${stats.count} p50=${stats.p50.toFixed(0)} ` +
        `p95=${stats.p95.toFixed(0)} p99=${stats.p99.toFixed(0)} max=${stats.max.toFixed(0)} ms`,
    );

    // ─── Assert 7 : redirect rapide (hot path bot/crawler) ─────────────
    // Non-auth doit retourner 307 (NextAuth redirect to /login)
    const expected = statuses.filter((s) => s === 307 || s === 302);
    expect(
      expected.length,
      `Non-auth GET /dashboard doit redirect (307/302) sur 100% des samples. ` +
        `Got distribution : 307=${statuses.filter((s) => s === 307).length} ` +
        `302=${statuses.filter((s) => s === 302).length} ` +
        `200=${statuses.filter((s) => s === 200).length} ` +
        `other=${statuses.filter((s) => ![200, 307, 302].includes(s)).join(',')}`,
    ).toBe(statuses.length);

    assertBudget(stats, BUDGET_DASHBOARD_REDIRECT, 'GET /dashboard (redirect)');

    // Pas de 5xx tolérés
    const serverErrors = statuses.filter((s) => s >= 500);
    expect(serverErrors.length, `${serverErrors.length} 5xx sur 50 redirects`).toBe(0);
  });

  test('Sanity : computeStats fonctionne avec un échantillon connu', () => {
    // Anti-régression du helper lui-même : si computeStats est cassé,
    // les asserts ci-dessus sont mensongers. Un mini-test bouclier.
    const fixedSamples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = computeStats(fixedSamples);
    expect(stats.p50).toBe(50); // ceil(50%*10)-1 = 4 → samples[4] = 50
    expect(stats.p95).toBe(100); // ceil(95%*10)-1 = 9 → 100
    expect(stats.p99).toBe(100);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBe(55);
    expect(stats.count).toBe(10);
    // Reference au RUN_STAMP pour traçabilité dans les logs CI
    expect(MEGA_RUN_STAMP).toBeTruthy();
  });
});
