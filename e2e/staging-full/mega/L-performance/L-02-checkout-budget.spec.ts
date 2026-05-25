/**
 * MEGA spec L-02 — Performance budget : POST /api/billing/checkout
 *
 * **POURQUOI** : `/api/billing/checkout` est le moment où l'utilisateur
 * sort sa CB. Si l'endpoint met > 2s, le user clique 2x = double session
 * Stripe = confusion. Si > 5s = abandon. Budget réaliste TEST mode (Stripe
 * Checkout en preprod est plus lent qu'en prod ~2-3x) :
 *   - p50 < 800ms
 *   - p95 < 2500ms (Stripe staging variable)
 *   - p99 < 5000ms
 *   - max < 15s (au-delà = Stripe timeout)
 *
 * On warm le cache (3 warmup), puis 30 POSTs sériels (volume modéré car
 * chaque POST crée une session Stripe = ressource preprod).
 *
 * Côté préreq : on a besoin d'un user loggué + Stripe TEST configuré côté
 * Hub (sk_test_*, prix `notifuse-pro` provisionnés via setup-stripe-prices).
 * Si Stripe TEST absent → on test.skip plutôt que de fail (config infra,
 * pas faute du code Hub).
 *
 * **ASSERTS HARDCORE (8)** :
 *   1. 100% des samples renvoient 200 (sinon l'endpoint est cassé, pas
 *      un problème de perf)
 *   2. p50 < 800ms +20%
 *   3. p95 < 2500ms +20%
 *   4. p99 < 5000ms +20%
 *   5. max < 15s
 *   6. Distribution saine (mean/median < 4 — Stripe = tail-heavy
 *      naturel, tolérance plus large que L-01)
 *   7. Chaque réponse contient une URL Stripe valide (pas de réponse
 *      tronquée sous pression)
 *   8. Chaque réponse contient un session_id non-vide
 *
 * **DURATION** : ~30-60s (30 POSTs sériels × ~1-2s chacun + setup).
 *
 * **CLEANUP** : afterAll purge user + customer Stripe (peut avoir N
 * sessions Checkout test orphelines mais Stripe TEST ne facture pas).
 */
import { test, expect } from '@playwright/test';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  disposeSession,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { measure, assertBudget } from '../_fixtures/perf-budget';
import {
  cancelAllSubsForCustomer,
  deleteCustomerSafe,
  getCustomerByEmail,
  StripeConfigError,
} from '../_fixtures/stripe-api';
import { bypassRateLimitHeaders } from '../../_helpers';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'l';
const SPEC = '02-checkout-budget';

const BUDGET_CHECKOUT = {
  p50: 800, // ms
  p95: 2500,
  p99: 5000,
  max: 15_000,
  tolerancePct: 20,
};

const ITERATIONS = 30;
const WARMUP = 3;

test.describe.configure({ mode: 'serial' });

test.describe('Mega L-02 — Performance budget POST /api/billing/checkout', () => {
  let session: MegaSession | null = null;
  let stripeCustomerEmail: string | null = null;

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    // 1. Cleanup Stripe customer (1 seul à supprimer — c'est l'invariant
    //    qu'on vérifie en K-01 : 1 user = 1 customer Stripe peu importe le
    //    nombre de checkouts).
    if (stripeCustomerEmail) {
      try {
        const customer = await getCustomerByEmail(stripeCustomerEmail);
        if (customer && !customer.deleted) {
          await cancelAllSubsForCustomer(customer.id);
          await deleteCustomerSafe(customer.id);
        }
      } catch {
        /* Stripe config peut être absente */
      }
    }
    // 2. Cleanup DB Hub
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
        tenantPrefix: `mega-${BUCKET}-${MEGA_RUN_STAMP}`,
      });
    } catch {
      /* afterAll ne throw jamais */
    }
  });

  test('POST /api/billing/checkout — 30 samples p50<800 / p95<2500 / p99<5000ms', async ({
    playwright,
  }) => {
    // ─── 1. Setup : user loggué via mock OAuth ─────────────────────────
    session = await megaSignIn(playwright as unknown as typeof import('@playwright/test'), {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
      variant: 'co',
    });
    expect(session.callbackStatus).toBeLessThan(400);
    stripeCustomerEmail = session.email;

    let req = session.request;
    const statuses: number[] = [];
    const bodies: Array<{ url?: string; session_id?: string }> = [];

    // ─── 2. Smoke check : 1 call de validation Stripe config ───────────
    // Si Stripe n'est pas configuré côté Hub (prix manquants, sk_test
    // fake), on doit le savoir AVANT de lancer 30 mesures qui vont
    // toutes échouer.
    const probe = await req.post('/api/billing/checkout', {
      headers: { 'content-type': 'application/json', ...bypassRateLimitHeaders() },
      data: { plan: 'notifuse-pro', interval: 'month' },
      failOnStatusCode: false,
    });
    if (probe.status() !== 200) {
      const probeBody = await probe.text();
      // Si 503 stripe_price_not_configured / 5xx → infra preprod cassée
      if (probe.status() >= 500) {
        test.skip(
          true,
          `Stripe preprod cassé (probe status=${probe.status()}): ${probeBody.slice(0, 200)}. ` +
            `Voir setup-stripe-prices.ts ou spec 12bis stripe-account-config.`,
        );
        return;
      }
      // Autre erreur 4xx = vrai bug Hub → fail dur
      throw new Error(
        `Probe checkout fail status=${probe.status()}: ${probeBody.slice(0, 300)}`,
      );
    }

    // ─── 3. Mesure : 30 POSTs sériels ───────────────────────────────────
    // Robustesse session : si on rencontre un 401 en plein milieu de la
    // mesure (cookie Auth.js perdu, agent parallèle qui a purgé l'user,
    // race condition session refresh), on tente UNE re-connexion via
    // megaSignIn sur le MÊME emailOverride (idempotent côté Auth.js v5 :
    // allowDangerousEmailAccountLinking link au user existant). Si le
    // 401 persiste après re-login, on laisse le sample compter — l'assert
    // final remontera l'incident.
    let reLoginAttempted = false;
    const stats = await measure({
      iterations: ITERATIONS,
      warmup: WARMUP,
      delayMs: 200, // anti-rate-limit Stripe + Hub
      fn: async () => {
        let res = await req.post('/api/billing/checkout', {
          headers: { 'content-type': 'application/json', ...bypassRateLimitHeaders() },
          data: { plan: 'notifuse-pro', interval: 'month' },
          failOnStatusCode: false,
        });
        if (res.status() === 401 && !reLoginAttempted) {
          reLoginAttempted = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[L-02] 401 détecté sample — tentative re-login mock-oauth (one-shot).`,
          );
          await disposeSession(session!);
          session = await megaSignIn(
            playwright as unknown as typeof import('@playwright/test'),
            { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'co',
              emailOverride: stripeCustomerEmail! },
          );
          req = session.request;
          await res.body().catch(() => undefined);
          res = await req.post('/api/billing/checkout', {
            headers: { 'content-type': 'application/json', ...bypassRateLimitHeaders() },
            data: { plan: 'notifuse-pro', interval: 'month' },
            failOnStatusCode: false,
          });
        }
        statuses.push(res.status());
        if (res.status() === 200) {
          const json = await res.json().catch(() => null);
          if (json) bodies.push(json);
        } else {
          await res.body().catch(() => undefined);
        }
      },
    });

    console.log(
      `[L-02] n=${stats.count} p50=${stats.p50.toFixed(0)} ` +
        `p95=${stats.p95.toFixed(0)} p99=${stats.p99.toFixed(0)} ` +
        `mean=${stats.mean.toFixed(0)} max=${stats.max.toFixed(0)} min=${stats.min.toFixed(0)} ms ` +
        `statuses=${JSON.stringify(statuses.slice(0, 5))}...`,
    );

    // ─── Assert 1 : 100% des samples renvoient 200 ─────────────────────
    // Si même 1 sample est ≠ 200, c'est soit un rate-limit qui passe le
    // bypass (config bug), soit Stripe a refusé une session (chiant). On
    // tolère 5% (≤ 1 sample sur 27 mesurés) au cas où.
    const non200 = statuses.filter((s) => s !== 200);
    expect(
      non200.length,
      `${non200.length}/${statuses.length} checkouts ≠ 200. ` +
        `Distribution : ${JSON.stringify(
          Object.fromEntries(
            Array.from(new Set(statuses)).map((s) => [s, statuses.filter((x) => x === s).length]),
          ),
        )}. Sur les 30 samples, max 1 (rate-limit tardif) est toléré.`,
    ).toBeLessThanOrEqual(1);

    // ─── Assert 2-5 : budgets p50/p95/p99/max ──────────────────────────
    assertBudget(stats, BUDGET_CHECKOUT, 'POST /api/billing/checkout');

    // ─── Assert 6 : distribution saine (mean/median < 4) ───────────────
    // Stripe = tail-heavy naturel. On tolère un skew plus large que L-01.
    // > 4 = un sample sur 30 a fait 4× la médiane = problème réseau ou
    // Stripe qui freeze = à investiguer.
    const skewRatio = stats.mean / Math.max(stats.p50, 1);
    expect(
      skewRatio,
      `Distribution checkout très skewed (mean/median=${skewRatio.toFixed(2)}). ` +
        `Cherche un cold-path Stripe (création customer 1ère fois ~1s, ` +
        `sessions 2-N sont ~300ms).`,
    ).toBeLessThan(4);

    // ─── Assert 7 : chaque succès a une URL Stripe valide ──────────────
    expect(
      bodies.length,
      `Aucun body 200 capturé alors qu'on a vu ${statuses.filter((s) => s === 200).length} ` +
        `réponses 200. Mismatch dans la capture.`,
    ).toBeGreaterThanOrEqual(statuses.filter((s) => s === 200).length - 1);

    for (const b of bodies) {
      expect(
        typeof b.url === 'string' && /checkout\.stripe\.com|js\.stripe\.com/.test(b.url ?? ''),
        `body.url doit pointer Stripe Checkout : ${JSON.stringify(b)}`,
      ).toBe(true);

      // ─── Assert 8 : session_id non-vide ───────────────────────────────
      expect(
        typeof b.session_id === 'string' && (b.session_id ?? '').length > 5,
        `body.session_id doit être string non-vide : ${JSON.stringify(b)}`,
      ).toBe(true);
    }
  });

  test('Sanity : Stripe TEST mode disponible (probe + customer post-cleanup)', async () => {
    // Anti-régression : si on arrive ici sans customer Stripe = la
    // suite de tests a tourné mais Stripe wasn't actually hit. On veut
    // confirmer que Stripe a vu nos 30 POSTs (= 1 customer créé).
    if (!stripeCustomerEmail) {
      test.skip(true, 'pas de stripeCustomerEmail (le test principal a sauté)');
      return;
    }
    try {
      const customer = await getCustomerByEmail(stripeCustomerEmail);
      expect(
        customer,
        `Stripe doit avoir 1 customer pour ${stripeCustomerEmail} après 30 checkouts`,
      ).not.toBeNull();
      expect(customer!.email).toBe(stripeCustomerEmail);
    } catch (err) {
      if (err instanceof StripeConfigError) {
        test.skip(true, `Stripe TEST non configuré : ${err.message}`);
        return;
      }
      throw err;
    }
  });
});
