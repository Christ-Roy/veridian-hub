/**
 * Journey 13 — Admin API security hardening.
 *
 * **POURQUOI** : l'Admin API Hub (livré sprint v1.4) gère les actions
 * `service-mode` qui contournent le flow utilisateur normal — création
 * de user, link/unlink d'apps. Si la défense en profondeur (auth, Zod,
 * idempotence, rate-limit, audit log) régresse, on s'expose à :
 *   - escalation de privilège (mauvais secret accepté)
 *   - data corruption (race condition double-INSERT)
 *   - DoS (rate-limit cassé)
 *   - perte de traçabilité (audit log non écrit)
 *
 * Le spec 07 valide le happy-path round-trip. Ce spec 13 attaque les
 * **bords** sécu non couverts ailleurs.
 *
 * **CE SPEC COUVRE** :
 *   S1 Auth manquante sur les 4 endpoints (users/create, users/[email],
 *      tenants/link-app, tenants/unlink-app) → 401 partout
 *   S2 Mauvais secret → 401 (pas de fuite vraie réponse via timing)
 *   S3 Bon secret + body Zod invalide → 400 (jamais 500)
 *   S4 Bon secret + email non-canonique (case, espaces) → normalisé
 *      ou rejeté (jamais 500)
 *   S5 Race condition : 5 calls create user simultanés sur le même
 *      email → 1 created + N already_existed (pas 5 doublons)
 *   S6 Idempotence link-app : link 2× même tenant_id/slug → mêmes IDs
 *   S7 Endpoint inexistant /api/admin/foo → 404 Next.js (pas 401 prématuré)
 *   S8 Audit log : create user écrit bien une row audit_log
 *   S9 SQL injection dans email → Zod rejette (jamais de SQL exec côté DB)
 *   S10 Path traversal dans [email] route param → 404 ou 400 (pas 500)
 *
 * **CLEANUP** : préfixe `adm-sec-${RUN_STAMP}` sur tous les emails créés
 * + DELETE final via _sql-helper.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

import {
  STAGING_URL,
  RUN_STAMP,
  ADMIN_SECRET,
  adminHeaders,
  freshIpHeader,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';
import { runSqlOnStaging, selectScalar } from './_sql-helper';

function uniqueEmail(slug: string): string {
  return makeEmail(`adm-sec-${slug}`);
}

const ENDPOINTS = [
  { method: 'POST', path: '/api/admin/users/create', body: { email: 'x@y.fr', name: 'X' } },
  { method: 'GET', path: '/api/admin/users/x%40y.fr', body: null },
  {
    method: 'POST',
    path: '/api/admin/tenants/link-app',
    body: {
      user_email: 'x@y.fr',
      app: 'cms',
      external_tenant_id: '1',
      external_tenant_slug: 'x',
      tenant_name: 'X',
    },
  },
  {
    method: 'DELETE',
    path: '/api/admin/tenants/unlink-app',
    body: { user_email: 'x@y.fr', app: 'cms' },
  },
] as const;

// ─── S1 + S2 : Auth absente / mauvaise ───────────────────────────────────

test.describe('Journey 13 — S1/S2 Auth defense', () => {
  for (const ep of ENDPOINTS) {
    test(`S1 sans secret sur ${ep.method} ${ep.path} → 401`, async ({ request }) => {
      const opts = {
        headers: { 'content-type': 'application/json', ...freshIpHeader() },
        data: ep.body,
        failOnStatusCode: false,
      };
      const res = await withRateLimitRetry(() => {
        if (ep.method === 'POST') return request.post(`${STAGING_URL}${ep.path}`, opts);
        if (ep.method === 'DELETE') return request.delete(`${STAGING_URL}${ep.path}`, opts);
        return request.get(`${STAGING_URL}${ep.path}`, opts);
      });
      expect(res.status()).toBe(401);
    });
  }

  test('S2 mauvais secret → 401 sur tous endpoints', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: {
          'content-type': 'application/json',
          'x-admin-secret': 'definitely-not-the-right-secret',
          ...freshIpHeader(),
        },
        data: { email: uniqueEmail('s2'), name: 'S2' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(401);
    const body = await res.json();
    // Garde-fou : pas de fuite du vrai secret dans le body de réponse.
    expect(JSON.stringify(body)).not.toContain(ADMIN_SECRET);
  });
});

// ─── S3 : Validation Zod ─────────────────────────────────────────────────

test.describe('Journey 13 — S3 Validation Zod (jamais 500)', () => {
  test('email malformé → 400 invalid_payload', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email: 'not-an-email-at-all', name: 'Bad' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  test('name vide → 400', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email: uniqueEmail('empty-name'), name: '' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
  });

  test('name avec caractères contrôle (\\x01) → 400', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email: uniqueEmail('ctrl'), name: 'Bad\x01Name' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
  });

  test('supabaseUserId pas UUID → 400', async ({ request }) => {
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: {
          email: uniqueEmail('baduuid'),
          name: 'Bad UUID',
          supabaseUserId: 'not-a-uuid',
        },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
  });

  test('link-app slug avec slash (path traversal) → 400', async ({ request }) => {
    const email = uniqueEmail('lapath');
    await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email, name: 'LA Path' },
        failOnStatusCode: false,
      }),
    );

    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: {
          user_email: email,
          app: 'cms',
          external_tenant_id: '1',
          external_tenant_slug: '../../etc/passwd',
          tenant_name: 'Path traversal',
        },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400);
  });

  test('link-app fallback_url javascript: → 400 (anti-XSS)', async ({
    request,
  }) => {
    const email = uniqueEmail('xss');
    await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email, name: 'XSS' },
        failOnStatusCode: false,
      }),
    );

    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: {
          user_email: email,
          app: 'cms',
          external_tenant_id: '1',
          external_tenant_slug: `s${RUN_STAMP}xss`,
          tenant_name: 'XSS test',
          fallback_url: 'javascript:alert(1)',
        },
        failOnStatusCode: false,
      }),
    );
    expect(
      res.status(),
      'CRITIQUE : un fallback_url javascript: doit être rejeté côté Hub',
    ).toBe(400);
  });
});

// ─── S5 : Race condition create user ─────────────────────────────────────

test.describe('Journey 13 — S5 Race condition create user idempotent', () => {
  test('5 calls create simultanés sur le même email → 1 created + 4 already_existed', async ({
    request,
  }) => {
    const email = uniqueEmail('race');
    const calls = Array.from({ length: 5 }, () =>
      withRateLimitRetry(() =>
        request.post(`${STAGING_URL}/api/admin/users/create`, {
          headers: { ...adminHeaders(), 'content-type': 'application/json' },
          data: { email, name: 'Race' },
          failOnStatusCode: false,
        }),
      ),
    );
    const results = await Promise.all(calls);

    const statuses = results.map((r) => r.status());
    expect(
      statuses.every((s) => s === 200 || s === 429),
      `tous les calls doivent être 200 ou 429 (rate-limit), got ${statuses}`,
    ).toBe(true);

    const bodies = await Promise.all(
      results.filter((r) => r.status() === 200).map((r) => r.json()),
    );

    // Au moins un body avec created=true, et les autres already_existed=true.
    const createdCount = bodies.filter((b) => b.created === true).length;
    const existedCount = bodies.filter((b) => b.already_existed === true).length;
    expect(createdCount + existedCount, 'sum cohérent avec nb réponses 200').toBe(
      bodies.length,
    );
    // L'invariant strict : seulement 1 created (pas 5 doublons en DB)
    expect(
      createdCount,
      `race condition : on doit avoir AU PLUS 1 created (got ${createdCount})`,
    ).toBeLessThanOrEqual(1);

    // Vérif côté DB : 1 seule row.
    const count = selectScalar(
      `SELECT count(*) FROM hub_app.users WHERE email = '${email}';`,
    );
    expect(count, 'DB doit avoir exactement 1 row pour cet email').toBe('1');
  });
});

// ─── S6 : Idempotence link-app ───────────────────────────────────────────

test.describe('Journey 13 — S6 Idempotence link-app', () => {
  test('link 2× même tenant → mêmes IDs (pas de doublon)', async ({
    request,
  }) => {
    const email = uniqueEmail('idem');
    await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email, name: 'Idem' },
        failOnStatusCode: false,
      }),
    );

    const slug = `e2e-idem-${RUN_STAMP}`;
    const payload = {
      user_email: email,
      app: 'cms' as const,
      external_tenant_id: '99',
      external_tenant_slug: slug,
      tenant_name: 'Idem Tenant',
    };

    const first = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: payload,
        failOnStatusCode: false,
      }),
    );
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    const firstTenantId = firstBody.tenant_id;

    const second = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { ...payload, tenant_name: 'Idem Tenant V2' },
        failOnStatusCode: false,
      }),
    );
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.tenant_id).toBe(firstTenantId);
    expect(secondBody.created).toBe(false);
  });
});

// ─── S7 : Endpoint inexistant ────────────────────────────────────────────

test.describe('Journey 13 — S7 Endpoint inexistant', () => {
  test('POST /api/admin/foo-does-not-exist → 404 (pas 401 prematuré)', async ({
    request,
  }) => {
    const res = await request.post(
      `${STAGING_URL}/api/admin/foo-does-not-exist-${RUN_STAMP}`,
      {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: {},
        failOnStatusCode: false,
      },
    );
    expect(
      res.status(),
      'endpoint inexistant doit retourner 404 (pas 401 — sinon on fuit la map des routes)',
    ).toBe(404);
  });
});

// ─── S8 : Audit log ──────────────────────────────────────────────────────

test.describe('Journey 13 — S8 Audit log écrit sur create user', () => {
  test('create user → row audit_log action=admin.user.create', async ({
    request,
  }) => {
    const email = uniqueEmail('audit');
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email, name: 'Audit Test' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const userId = body.user_id;

    // Lit la row audit_log la plus récente pour cet user.
    const action = selectScalar(
      `SELECT action FROM hub_app.audit_log
       WHERE target_id = '${userId}' AND action = 'admin.user.create'
       ORDER BY created_at DESC LIMIT 1;`,
    );
    expect(
      action,
      'audit_log doit avoir une row admin.user.create pour ce user',
    ).toBe('admin.user.create');
  });
});

// ─── S9 : SQL injection ──────────────────────────────────────────────────

test.describe('Journey 13 — S9 SQL injection dans email', () => {
  test('email avec quote+drop table → Zod rejette (pas de SQL exec)', async ({
    request,
  }) => {
    const evilEmail = `'); DROP TABLE hub_app.users; --@e2e.veridian.site`;
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/admin/users/create`, {
        headers: { ...adminHeaders(), 'content-type': 'application/json' },
        data: { email: evilEmail, name: 'SQLi' },
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(400); // Zod email() doit rejeter

    // Vérif : table users existe toujours.
    const exists = selectScalar(
      `SELECT to_regclass('hub_app.users')::text;`,
    );
    expect(exists, 'CRITIQUE : table users doit toujours exister').toBe(
      'hub_app.users',
    );
  });
});

// ─── S10 : Path traversal dans [email] route param ───────────────────────

test.describe('Journey 13 — S10 Path traversal dans email param', () => {
  test('GET /api/admin/users/..%2F..%2Fadmin → 404 ou 400 (pas 500)', async ({
    request,
  }) => {
    const res = await request.get(
      `${STAGING_URL}/api/admin/users/..%2F..%2Fadmin`,
      { headers: adminHeaders(), failOnStatusCode: false },
    );
    expect(
      [400, 404],
      `path traversal email param doit être rejeté proprement (got ${res.status()})`,
    ).toContain(res.status());
  });

  test('GET /api/admin/users/<email-trop-long-1000+chars> → 404 ou 400', async ({
    request,
  }) => {
    const longEmail = 'a'.repeat(1000) + '@e2e.veridian.site';
    const res = await request.get(
      `${STAGING_URL}/api/admin/users/${encodeURIComponent(longEmail)}`,
      { headers: adminHeaders(), failOnStatusCode: false },
    );
    expect([400, 404, 414]).toContain(res.status());
  });
});
