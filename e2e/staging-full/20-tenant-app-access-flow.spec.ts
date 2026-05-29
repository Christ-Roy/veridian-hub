/**
 * Journey 20 — Activation des apps gated par tenant (admin SaaS).
 *
 * Valide contre staging réel l'endpoint POST /api/admin/tenants/app-access
 * (livré 2026-05-29) : Robert active/désactive par tenant les apps PAS grand
 * public (twenty/CRM, analytics, cms). Défaut OFF. Prospection/Notifuse hors
 * périmètre.
 *
 * Scénario :
 *   1. crée un user (admin users/create)
 *   2. POST app-access enabled=true (twenty) → 200 + row tenant_apps en DB
 *   3. POST app-access enabled=false → 200 + row maj enabled=false
 *   4. erreurs : 401 sans secret, 400 app non-gated (prospection), 404 user inconnu
 *   5. cleanup user + row tenant_apps
 *
 * Le endpoint n'est PAS gardé par DEPLOY_ENV (contrairement à One Tap) : il
 * marche en staging comme en prod. Mock OAuth non requis (full API admin).
 */
import { test, expect } from '@playwright/test';

import {
  STAGING_URL,
  adminHeaders,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';
import { runSqlOnStaging, selectScalar } from './_sql-helper';

function uniqueEmail(slug: string): string {
  return makeEmail(`appaccess-${slug}`);
}

const APP_ACCESS = `${STAGING_URL}/api/admin/tenants/app-access`;

// Sériel : le test "setup" crée le user dont dépendent les tests suivants.
test.describe.configure({ mode: 'serial' });

test.describe('Journey 20 — Tenant app-access (gating admin)', () => {
  const email = uniqueEmail('flow');
  // UUID bridge fixe pour ce user de test (idempotent sur re-run).
  const BRIDGE_UUID = 'a0000000-0000-4000-8000-00000000a20e';

  test.afterAll(async () => {
    // Cleanup : row tenant_apps + user créé.
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenant_apps WHERE user_id IN (
           SELECT supabase_user_id::uuid FROM hub_app.users
           WHERE email = '${email}' AND supabase_user_id IS NOT NULL
         );`,
      );
      runSqlOnStaging(`DELETE FROM hub_app.users WHERE email = '${email}';`);
    } catch {
      /* swallow */
    }
  });

  test('setup : crée le user de test (avec UUID bridge)', async ({ request }) => {
    // supabase_user_id explicite : sans lui, users/create ne pose PAS d'UUID
    // bridge → app-access renverrait 404 (l'endpoint l'exige pour pivoter
    // vers tenant_apps). UUID v4 déterministe par RUN pour rester idempotent.
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: {
          email,
          name: 'App Access Flow',
          supabase_user_id: BRIDGE_UUID,
        },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
  });

  test('401 sans secret admin', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(APP_ACCESS, {
        data: { user_email: email, app: 'twenty', enabled: true },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(401);
  });

  test('400 sur app non-gated (prospection rejetée)', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(APP_ACCESS, {
        headers: adminHeaders(),
        data: { user_email: email, app: 'prospection', enabled: true },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
  });

  test('404 sur user inconnu', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(APP_ACCESS, {
        headers: adminHeaders(),
        data: { user_email: uniqueEmail('ghost'), app: 'twenty', enabled: true },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(404);
  });

  test('activation twenty → 200 + row enabled=true en DB', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(APP_ACCESS, {
        headers: adminHeaders(),
        data: { user_email: email, app: 'twenty', enabled: true },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ app: 'twenty', enabled: true });

    // Vérif DB : la row tenant_apps existe et est enabled.
    const enabled = selectScalar(
      `SELECT enabled FROM hub_app.tenant_apps ta
       JOIN hub_app.users u ON u.supabase_user_id::uuid = ta.user_id
       WHERE u.email = '${email}' AND ta.app_key = 'twenty'`,
    );
    expect(enabled).toBe('t');
  });

  test('désactivation twenty → 200 + row enabled=false en DB', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(APP_ACCESS, {
        headers: adminHeaders(),
        data: { user_email: email, app: 'twenty', enabled: false },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ app: 'twenty', enabled: false });

    const enabled = selectScalar(
      `SELECT enabled FROM hub_app.tenant_apps ta
       JOIN hub_app.users u ON u.supabase_user_id::uuid = ta.user_id
       WHERE u.email = '${email}' AND ta.app_key = 'twenty'`,
    );
    expect(enabled).toBe('f');
  });
});
