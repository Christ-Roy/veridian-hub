/**
 * Journey 12 — Stripe billing flow (pricing → checkout → webhook).
 *
 * **POURQUOI** : le flow billing est le revenue path principal. Tout bug
 * sur /pricing (plans mal affichés), /api/billing/checkout (mauvais price
 * ID, customer non-créé) ou /api/webhooks (sub pas dispatchée vers les
 * apps) coûte directement du chiffre d'affaires.
 *
 * Le spec 09 couvre déjà les invariants signature/idempotence du webhook
 * dispatcher Stripe. Ce spec 12 couvre la **partie outbound** (page pricing
 * + checkout session creation) et un complément end-to-end sur le webhook
 * Stripe en mode "vraies clés de test".
 *
 * **CE QUE CE SPEC COUVRE** :
 *   S1 GET /pricing rend la page avec ≥ 1 plan affiché (notifuse-pro,
 *      prospection-pro, etc.) — invariant non-cassage
 *   S2 GET /pricing affiche le toggle mensuel/annuel
 *   S3 POST /api/billing/checkout sans auth → 401 (Auth.js requireUser)
 *   S4 POST /api/billing/checkout auth mock + plan invalide → 400 unknown_plan
 *   S5 POST /api/billing/checkout auth + interval invalide → 400 invalid_payload
 *   S6 POST /api/billing/checkout auth + plan='notifuse-free' →
 *      400 plan_is_free (pas de checkout pour plan gratuit)
 *   S7 POST /api/billing/checkout auth + plan='notifuse-pro' → STRICT 200
 *      avec body.url = https://checkout.stripe.com/... + body.session_id.
 *      Plus de fallback 502/503 toléré (Stripe TEST staging entièrement
 *      configuré depuis 2026-05-23 — un 5xx ici = vrai bug Stripe à fixer,
 *      comme le head_office manquant qui a masqué un checkout pété pendant
 *      6h avant durcissement). Cf. ticket 2026-05-23-e2e-harden-tolerances.
 *   S8 POST /api/billing/checkout body vide / mauvais content-type → 400
 *   S9 GET /api/webhooks sans body → 400 (signature manquante / body vide)
 *
 * **DÉPENDANCES STAGING** :
 *   - Mock OAuth provider actif (OAUTH_TEST_PROVIDER=true)
 *   - STRIPE_SECRET_KEY_TEST + Stripe Tax head_office FR configurés
 *     (cf. spec 12bis qui asserte la config compte côté API Stripe)
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

import {
  STAGING_URL,
  RUN_STAMP,
  uniqueEmail as makeEmail,
  freshIpHeader,
  withRateLimitRetry,
} from './_helpers';

function uniqueEmail(slug: string): string {
  return makeEmail(`billing-${slug}`);
}

async function mockOauthLogin(
  playwright: typeof import('@playwright/test'),
  email: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const cb = await ctx.post('/api/auth/callback/mock-oauth', {
    form: {
      csrfToken,
      email,
      mockProvider: 'google',
      mockEmailVerified: 'true',
      callbackUrl: `${STAGING_URL}/dashboard`,
      json: 'true',
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  expect(cb.status(), `mock OAuth callback for ${email}`).toBeLessThan(400);
  return ctx;
}

// ─── S1 + S2 : Page /pricing ─────────────────────────────────────────────

test.describe('Journey 12 — S1/S2 page /pricing', () => {
  test('S1 : rend les plans canoniques (au moins notifuse-pro ou prospection-pro)', async ({
    page,
  }) => {
    await page.goto(`${STAGING_URL}/pricing`);
    // Le titre h1 ou la grille de plans doit charger. On cherche un mot
    // métier non-marketing pour éviter les flake sur les changements
    // copywriting.
    await expect(
      page.locator('text=/Pro|Business|Free|Notifuse|Prospection/i').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Vérifier qu'on a bien ≥ 1 prix affiché (pattern € euros)
    const priceLocator = page.locator('text=/\\d+\\s*€|€\\s*\\d+|29\\s*€|99\\s*€/').first();
    await expect(priceLocator, 'au moins un prix EUR doit être affiché').toBeVisible({
      timeout: 5_000,
    });
  });

  test('S2 : page accessible publiquement (pas auth requise)', async ({ page }) => {
    // S'assurer qu'on n'a pas de cookie de session.
    await page.context().clearCookies();
    const res = await page.goto(`${STAGING_URL}/pricing`);
    expect(res?.status(), '/pricing doit être public').toBe(200);
  });
});

// ─── S3 : Auth requirements ──────────────────────────────────────────────

test.describe('Journey 12 — S3 POST /api/billing/checkout sans auth', () => {
  test('sans session → 401', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/billing/checkout`, {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: { plan: 'notifuse-pro', interval: 'month' },
        failOnStatusCode: false,
      }),
    );
    expect(
      [401, 403],
      `sans session checkout doit refuser (got ${res.status()})`,
    ).toContain(res.status());
  });
});

// ─── S4 + S5 + S6 + S7 + S8 : Validation + plans ─────────────────────────

test.describe('Journey 12 — S4-S8 POST /api/billing/checkout avec auth', () => {
  test('S4 : plan inconnu → 400 unknown_plan', async ({ request, playwright }) => {
    const email = uniqueEmail('s4');
    const ctx = await mockOauthLogin(playwright, email);
    try {
      const res = await ctx.post('/api/billing/checkout', {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: { plan: 'totally-not-a-plan-key', interval: 'month' },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('unknown_plan');
    } finally {
      await ctx.dispose();
    }
  });

  test('S5 : interval invalide → 400 invalid_payload', async ({
    request,
    playwright,
  }) => {
    const ctx = await mockOauthLogin(playwright, uniqueEmail('s5'));
    try {
      const res = await ctx.post('/api/billing/checkout', {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: { plan: 'notifuse-pro', interval: 'daily' as 'month' },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      expect(['invalid_payload', 'unknown_plan']).toContain(body.error);
    } finally {
      await ctx.dispose();
    }
  });

  test('S6 : plan free (notifuse-free) → 400 plan_is_free (pas de checkout)', async ({
    request,
    playwright,
  }) => {
    const ctx = await mockOauthLogin(playwright, uniqueEmail('s6'));
    try {
      const res = await ctx.post('/api/billing/checkout', {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: { plan: 'notifuse-free', interval: 'month' },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      // Selon catalogue : plan_is_free OU plan_not_payable selon plan_source.
      expect(['plan_is_free', 'plan_not_payable']).toContain(body.error);
    } finally {
      await ctx.dispose();
    }
  });

  test('S7 : plan payable → STRICT 200 + URL Stripe valide (plus de fallback 5xx)', async ({
    request,
    playwright,
  }) => {
    const ctx = await mockOauthLogin(playwright, uniqueEmail('s7'));
    try {
      const res = await ctx.post('/api/billing/checkout', {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: { plan: 'notifuse-pro', interval: 'month' },
        failOnStatusCode: false,
      });

      // DURCI 2026-05-23 (ticket e2e-harden-tolerances) :
      // L'ancienne tolérance `[200, 502, 503]` a masqué pendant 6h un vrai
      // bug Stripe (head_office: null côté preprod → automatic_tax rejetait
      // chaque session avec stripe_session_failed). Plus jamais ça.
      // Staging a maintenant Stripe TEST entièrement configuré (Prices,
      // tax.head_office FR, automatic_tax actif). Un 5xx ici = vrai bug à
      // fixer côté Hub ou côté Stripe — pas à tolérer.
      const bodyText = await res.text();
      expect(
        res.status(),
        `Checkout doit retourner 200, sinon Stripe est cassé. ` +
          `Body: ${bodyText.slice(0, 500)}. ` +
          `Si 503 stripe_price_not_configured → vérifier setup-stripe-prices.ts. ` +
          `Si 5xx avec stripe_session_failed → vérifier head_office (cf. spec 12bis).`,
      ).toBe(200);

      const data = JSON.parse(bodyText) as {
        url?: unknown;
        session_id?: unknown;
      };
      expect(
        typeof data.url,
        'session.url doit être une string Stripe',
      ).toBe('string');
      expect(data.url as string).toMatch(
        /^https:\/\/(checkout\.stripe\.com|js\.stripe\.com)/,
      );
      expect(
        typeof data.session_id,
        'session_id doit être présent pour idempotence côté client',
      ).toBe('string');
    } finally {
      await ctx.dispose();
    }
  });

  test('S8 : body invalide JSON → 400', async ({ request, playwright }) => {
    const ctx = await mockOauthLogin(playwright, uniqueEmail('s8'));
    try {
      const res = await ctx.post('/api/billing/checkout', {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: '{not valid json',
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const body = await res.json();
      // Soit invalid_json soit invalid_payload selon ordre des checks.
      expect(['invalid_json', 'invalid_payload']).toContain(body.error);
    } finally {
      await ctx.dispose();
    }
  });
});

// ─── S9 : Stripe webhook root ────────────────────────────────────────────

test.describe('Journey 12 — S9 webhook /api/webhooks sans signature', () => {
  test('POST sans body ni signature → 400', async ({ request }) => {
    const res = await request.post(`${STAGING_URL}/api/webhooks`, {
      headers: { 'content-type': 'application/json', ...freshIpHeader() },
      data: '',
      failOnStatusCode: false,
    });
    expect([400, 401]).toContain(res.status());
    // INVARIANT critique : pas de 200 sans signature valide.
    expect(
      res.status(),
      'CRITIQUE : un webhook sans signature ne doit JAMAIS retourner 200',
    ).not.toBe(200);
  });
});
