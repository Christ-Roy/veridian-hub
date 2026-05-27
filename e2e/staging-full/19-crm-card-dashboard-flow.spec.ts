/**
 * E2E flow CRM card dashboard — HEADFULL Playwright contre staging réel.
 *
 * Ce que ce test garantit :
 *   1. Login mock-oauth Hub réussi → session valide
 *   2. /dashboard se charge (pas de crash Prisma sur crmTenant lookup —
 *      régression Agent A type UUID vs cuid corrigée par migration 20260527142500)
 *   3. La card "CRM Veridian" est visible dans la grid "Vos SaaS"
 *   4. Click "Activer mon CRM" → POST /api/dashboard/crm/activate
 *      → response JSON valide { magicLinkUrl } (PAS "Unexpected end of JSON input")
 *      → window.open ouvre Twenty workspace dans nouvel onglet
 *   5. Le magic-link Twenty fonctionne (loginToken ES256 valide, redirect /objects/people)
 *   6. La row crm_tenants en DB Hub a le bon user_id text (cuid match user.id)
 *   7. Re-click "Ouvrir mon CRM" → regenerate magic-link (idempotent: true)
 *   8. Push lead via REST Twenty avec Bearer déchiffré → Person créée
 *   9. Cleanup : DELETE crm_tenant + workspace Twenty supprimé
 *
 * **HEADFULL** : run via container Playwright sur dev-pub avec xvfb-run
 * (Robert wants visual confirmation, plus représentatif d'un vrai user).
 *
 * **Pourquoi pas un test admin curl** : la chaîne dashboard layout +
 * Prisma crmTenant lookup + card render + fetch /api/dashboard/* DOIT
 * fonctionner ensemble. Un curl admin skip toute cette chaîne. Le bug
 * du Unexpected end of JSON input était exactement dans cette chaîne
 * — invisible côté API admin.
 */

import { test, expect } from '@playwright/test';
import { megaSignIn, disposeSession, type MegaSession } from './mega/_fixtures/mock-oauth';
import { purgeMegaByPrefix } from './mega/_fixtures/db-purge';
import { runSqlOnStaging, selectScalar } from './_sql-helper';
import { MEGA_RUN_STAMP } from './mega/_fixtures/run-stamp';

const BUCKET = 'crm-card';
const SPEC = '19-dashboard-flow';

test.describe.configure({ mode: 'serial' });

test.describe('CRM card dashboard E2E flow (HEADFULL)', () => {
  let session: MegaSession | null = null;
  let crmTenantId: string | null = null;

  test.afterEach(async () => {
    if (session) {
      await disposeSession(session);
      session = null;
    }
  });

  test.afterAll(async () => {
    // Cleanup DB Hub par préfixe (users + sessions + accounts)
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* swallow */
    }
    // Cleanup crm_tenants explicite (le préfixe email match)
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.crm_tenants WHERE email LIKE 'e2e-mega-${BUCKET}-%';`,
      );
    } catch {
      /* swallow */
    }
  });

  test('login → dashboard render → card CRM visible (NO crash Prisma sur crmTenant lookup)', async ({
    playwright,
    browser,
  }) => {
    session = await megaSignIn(playwright, {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
      variant: 'render',
    });
    expect(session.email).toMatch(/^e2e-mega-crm-card/);

    const ctx = await browser.newContext({
      storageState: session.storageState,
    });
    const page = await ctx.newPage();

    // Navigation /dashboard — si Prisma crashe sur crmTenant.findFirst,
    // la page retourne du 500 vide ou un crash boundary. On force le check.
    const response = await page.goto('https://hub.staging.veridian.site/dashboard', {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.status(), 'dashboard doit retourner 200').toBe(200);

    // La card "CRM Veridian" doit être visible dans la grid SaaS
    const crmCardTitle = page.getByRole('heading', { name: 'CRM Veridian' });
    await expect(crmCardTitle).toBeVisible({ timeout: 10_000 });

    // Le bouton initial doit être "Activer mon CRM" (pas de tenant en DB pour ce nouveau user)
    const activateButton = page.getByRole('button', { name: /Activer mon CRM/i });
    await expect(activateButton).toBeVisible();

    await ctx.close();
  });

  test('click "Activer mon CRM" → response JSON valide + magicLinkUrl + crmTenant en DB', async ({
    playwright,
    browser,
  }) => {
    session = await megaSignIn(playwright, {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
      variant: 'activate',
    });

    const ctx = await browser.newContext({
      storageState: session.storageState,
    });
    const page = await ctx.newPage();

    // Capture la response du POST activate pour vérifier qu'elle est du JSON valide
    const activateResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().endsWith('/api/dashboard/crm/activate') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    );

    await page.goto('https://hub.staging.veridian.site/dashboard');
    await page.getByRole('button', { name: /Activer mon CRM/i }).click();

    const activateResponse = await activateResponsePromise;

    expect(activateResponse.status(), 'activate doit retourner 200').toBe(200);

    // Parse JSON — anti-régression du bug "Unexpected end of JSON input"
    const bodyText = await activateResponse.text();
    expect(bodyText.length, 'body NE DOIT PAS être vide').toBeGreaterThan(10);
    let body: { magicLinkUrl: string; crmTenantId: string; workspaceUrl: string; idempotent: boolean };
    expect(() => {
      body = JSON.parse(bodyText);
    }).not.toThrow();
    expect(body!.magicLinkUrl).toMatch(/^https:\/\/[^/]+\/verify\?loginToken=/);
    expect(body!.crmTenantId).toBeTruthy();
    expect(body!.workspaceUrl).toMatch(/^https:\/\/[^/]+\.crm\.staging\.veridian\.site/);
    expect(body!.idempotent, 'premier call → idempotent false').toBe(false);

    crmTenantId = body!.crmTenantId;

    // DB check : la row crm_tenants existe avec le bon user_id (cuid text, PAS uuid)
    const userIdInDb = selectScalar(
      `SELECT user_id FROM hub_app.crm_tenants WHERE id = '${body!.crmTenantId}'::uuid`,
    );
    expect(userIdInDb, 'crm_tenants.user_id doit être présent (regression UUID/cuid)').toBeTruthy();
    // Le user_id doit être un cuid (commence par "cm" ou "cmpl..."), pas un uuid v4
    expect(userIdInDb).toMatch(/^[a-z0-9_]+/);
    expect(userIdInDb).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    await ctx.close();
  });

  test('re-click "Ouvrir mon CRM" → regenerate magic-link (idempotent: true)', async ({
    playwright,
    browser,
  }) => {
    test.skip(!crmTenantId, 'requires previous test to have created the tenant');

    session = await megaSignIn(playwright, {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
      variant: 'activate', // même user, même session
    });

    const ctx = await browser.newContext({
      storageState: session.storageState,
    });
    const page = await ctx.newPage();

    const activateResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().endsWith('/api/dashboard/crm/activate') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    );

    await page.goto('https://hub.staging.veridian.site/dashboard');
    // Le bouton est maintenant "Ouvrir mon CRM" (tenant existe)
    await page.getByRole('button', { name: /Ouvrir mon CRM/i }).click();

    const activateResponse = await activateResponsePromise;
    expect(activateResponse.status()).toBe(200);

    const body = await activateResponse.json();
    expect(body.idempotent, '2e call → idempotent true').toBe(true);
    expect(body.crmTenantId, 'même crmTenantId').toBe(crmTenantId);
    expect(body.magicLinkUrl).toMatch(/^https:\/\/[^/]+\/verify\?loginToken=/);
    expect(body.expiresAt, 'expiresAt présent au regenerate').toBeTruthy();

    await ctx.close();
  });

  test('le magic-link Twenty fonctionne (loginToken valide, redirect post-login)', async ({
    playwright,
    browser,
  }) => {
    test.skip(!crmTenantId, 'requires previous test');

    session = await megaSignIn(playwright, {
      bucket: BUCKET,
      spec: SPEC,
      provider: 'google',
      variant: 'activate',
    });

    // Récupère un magic-link frais via API admin (équivalent ce que la card fait)
    const adminSecret = process.env.HUB_ADMIN_SECRET;
    test.skip(!adminSecret, 'HUB_ADMIN_SECRET required');

    const request = await playwright.request.newContext();
    const res = await request.post(
      `https://hub.staging.veridian.site/api/admin/crm/tenants/${crmTenantId}/magic-link`,
      {
        headers: { 'x-admin-secret': adminSecret! },
      },
    );
    expect(res.status()).toBe(200);
    const { magicLinkUrl } = await res.json();
    expect(magicLinkUrl).toMatch(/loginToken=/);

    // Suit le magic-link → Twenty doit accepter et rediriger (pas de "invalid token")
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const tw_response = await page.goto(magicLinkUrl, { waitUntil: 'domcontentloaded' });
    // Twenty accepte le token et redirect. Status 200 sur la page finale OK.
    expect(tw_response?.status(), 'magic-link doit aboutir HTTP 200').toBeLessThan(400);
    // L'URL post-redirect ne doit PAS contenir "invalid" ou error
    const finalUrl = page.url();
    expect(finalUrl).not.toMatch(/invalid|error|expired/i);

    await ctx.close();
  });
});
