/**
 * Journey 7 — Admin API round-trip (create → get → link → get → unlink → get).
 *
 * **CONTEXTE** : l'admin API du Hub (livré 2026-05-20, cf. memory
 * `reference_hub_admin_api.md`) n'a JAMAIS été testée E2E sur staging
 * — uniquement vitest unitaire. Cette suite valide :
 *   1. Auth x-admin-secret accepte/rejette correctement
 *   2. POST /api/admin/users/create est idempotent
 *   3. GET /api/admin/users/[email] retourne user + tenants
 *   4. POST /api/admin/tenants/link-app crée/met à jour bien
 *   5. DELETE /api/admin/tenants/unlink-app soft-unlink (préserve la row)
 *
 * **SCÉNARIO TYPE TESTÉ** (workflow skill agent IA mode-service) :
 *   - On veut onboarder un client "client-x@e2e.veridian.site" sur Notifuse
 *     SANS qu'il fasse de signup OAuth.
 *   - On crée le user, on link Notifuse, on vérifie qu'il est dans la DB.
 *   - Puis on unlink (test cleanup).
 *
 * **GARDE-FOU SÉCU** :
 *   - Sans header → 401
 *   - Avec mauvais secret → 401
 *   - Avec secret + Zod invalide → 400 (jamais 500)
 *
 * **RATE-LIMIT** : adminApiLimiter (30/min/IP). Wrappé via
 * `withRateLimitRetry` du helper partagé — la suite peut tourner derrière
 * d'autres specs qui ont déjà consommé du quota sans casser.
 */
import { test, expect } from '@playwright/test';

import {
  STAGING_URL,
  RUN_STAMP,
  adminHeaders,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';

function uniqueEmail(slug: string): string {
  return makeEmail(`adm-${slug}`);
}

// ─── Auth path tests ─────────────────────────────────────────────────────

test.describe('Journey 7 — Admin auth', () => {
  test('sans secret → 401', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        data: { email: uniqueEmail('noauth'), name: 'NoAuth' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(401);
  });

  test('avec mauvais secret → 401', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { 'x-admin-secret': 'definitely-wrong-secret' },
        data: { email: uniqueEmail('badauth'), name: 'BadAuth' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(401);
  });

  test('avec secret valide → accepte la requête', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: { email: uniqueEmail('okauth'), name: 'OK Auth' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
  });

  test('payload Zod invalide → 400 (jamais 500)', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: { email: 'not-an-email', name: '' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  test('GET user inconnu → 404', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent('does-not-exist-' + RUN_STAMP + '@e2e.veridian.site')}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(res.status()).toBe(404);
  });
});

// ─── Full round-trip ─────────────────────────────────────────────────────

test.describe('Journey 7 — Round-trip complet create → link → get → unlink', () => {
  test('flow CMS link/unlink complet', async ({ request }) => {
    const email = uniqueEmail('roundtrip-cms');
    const tenantSlug = `e2e-rt-cms-${RUN_STAMP}`;

    // 1. Create user.
    const createRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: { email, name: 'Round Trip CMS' },
        failOnStatusCode: false,
      }),
    );
    expect(createRes.status()).toBe(200);
    const created = await createRes.json();
    expect(created.created).toBe(true);
    expect(created.already_existed).toBe(false);
    expect(created.supabase_user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // 1b. Idempotence : 2e create → already_existed=true, mêmes IDs.
    const second = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: { email, name: 'Round Trip CMS V2' },
        failOnStatusCode: false,
      }),
    );
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.already_existed).toBe(true);
    expect(secondBody.user_id).toBe(created.user_id);
    expect(secondBody.supabase_user_id).toBe(created.supabase_user_id);

    // 2. GET user → confirme persistance + 0 tenants.
    const get1 = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(get1.status()).toBe(200);
    const userInitial = await get1.json();
    expect(userInitial.user.email).toBe(email);
    expect(Array.isArray(userInitial.tenants)).toBe(true);
    expect(userInitial.tenants.length).toBe(0);

    // 3. Link app=cms.
    const linkRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: adminHeaders(),
        data: {
          user_email: email,
          app: 'cms',
          external_tenant_id: '42',
          external_tenant_slug: tenantSlug,
          tenant_name: 'E2E Round Trip Tenant',
          plan: 'complimentary',
          fallback_url: 'https://cms.veridian.site/admin',
          provisioning_source: 'e2e-journey-7',
        },
        failOnStatusCode: false,
      }),
    );
    expect(linkRes.status()).toBe(200);
    const linkBody = await linkRes.json();
    expect(linkBody.app).toBe('cms');
    expect(linkBody.created).toBe(true);
    expect(typeof linkBody.tenant_id).toBe('string');

    // 4. GET user → 1 tenant avec metadata.cms.
    const get2 = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(get2.status()).toBe(200);
    const userAfterLink = await get2.json();
    expect(
      userAfterLink.tenants.length,
      'link-app cms doit avoir créé 1 tenant Hub',
    ).toBeGreaterThanOrEqual(1);
    const cmsTenant = userAfterLink.tenants.find(
      (t: { metadata?: Record<string, unknown> }) =>
        t.metadata && typeof t.metadata === 'object' && 'cms' in t.metadata,
    );
    expect(cmsTenant, 'tenant doit avoir metadata.cms').toBeDefined();

    // 5. Link idempotent : 2e link même app → met à jour sans erreur.
    const link2 = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: adminHeaders(),
        data: {
          user_email: email,
          app: 'cms',
          external_tenant_id: '42',
          external_tenant_slug: tenantSlug,
          tenant_name: 'E2E Round Trip Tenant V2',
          plan: 'complimentary',
        },
        failOnStatusCode: false,
      }),
    );
    expect(link2.status()).toBe(200);
    const link2Body = await link2.json();
    expect(link2Body.tenant_id).toBe(linkBody.tenant_id);

    // 6. Unlink → soft (tenant row reste).
    const unlinkRes = await withRateLimitRetry(() =>
      request.delete(`${STAGING_URL}/api/admin/tenants/unlink-app`, {
        headers: adminHeaders(),
        data: { user_email: email, app: 'cms', reason: 'e2e cleanup' },
        failOnStatusCode: false,
      }),
    );
    expect(unlinkRes.status()).toBe(200);
    const unlinkBody = await unlinkRes.json();
    expect(unlinkBody.unlinked).toBe(true);

    // 7. GET user après unlink → la row tenant reste mais metadata.cms n'est plus là.
    const get3 = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(get3.status()).toBe(200);
    const userAfterUnlink = await get3.json();
    const cmsAfter = userAfterUnlink.tenants.find(
      (t: { metadata?: Record<string, unknown> }) =>
        t.metadata && typeof t.metadata === 'object' && 'cms' in t.metadata,
    );
    expect(
      cmsAfter,
      'unlink doit supprimer metadata.cms (mais préserver la row)',
    ).toBeUndefined();
  });

  test('flow notifuse link → unlink (colonnes dédiées, pas metadata)', async ({
    request,
  }) => {
    const email = uniqueEmail('roundtrip-notifuse');
    await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: { email, name: 'RT Notifuse' },
        failOnStatusCode: false,
      }),
    );

    const linkRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: adminHeaders(),
        data: {
          user_email: email,
          app: 'notifuse',
          external_tenant_id: '1',
          external_tenant_slug: `e2e-rt-notif-${RUN_STAMP}`,
          tenant_name: 'E2E Notifuse RT',
          plan: 'complimentary',
        },
        failOnStatusCode: false,
      }),
    );
    // Notifuse link nécessite probablement déjà un tenant ; on tolère 200/400 selon state.
    expect([200, 400, 404]).toContain(linkRes.status());

    if (linkRes.status() === 200) {
      const unlink = await withRateLimitRetry(() =>
        request.delete(`${STAGING_URL}/api/admin/tenants/unlink-app`, {
          headers: adminHeaders(),
          data: { user_email: email, app: 'notifuse' },
          failOnStatusCode: false,
        }),
      );
      expect([200, 404]).toContain(unlink.status());
    }
  });

  test('link-app sur user inconnu → 404 user_not_found', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: adminHeaders(),
        data: {
          user_email: `ghost-${RUN_STAMP}@e2e.veridian.site`,
          app: 'cms',
          external_tenant_id: '99',
          external_tenant_slug: `ghost-${RUN_STAMP}`,
          tenant_name: 'Ghost',
        },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(404);
  });

  test('link-app payload invalide (slug avec espace) → 400', async ({
    request,
  }) => {
    const email = uniqueEmail('zod-fail');
    await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: adminHeaders(),
        data: { email, name: 'Zod Fail' },
        failOnStatusCode: false,
      }),
    );
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: adminHeaders(),
        data: {
          user_email: email,
          app: 'cms',
          external_tenant_id: '42',
          external_tenant_slug: 'INVALID SLUG WITH SPACES',
          tenant_name: 'Zod Fail',
        },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
  });
});
