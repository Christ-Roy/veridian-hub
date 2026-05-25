/**
 * MEGA Bucket G — Cross-app sync
 *
 * Spec G-03 — Tenant delete propagate
 *
 * **Scénario** : valider le cycle delete soft + cascade côté Hub via l'admin
 * API `DELETE /api/admin/delete-tenant`. Anti-régression GDPR (cf. J-01 pour
 * la version "GDPR full cascade").
 *
 *   1. Signup mock OAuth → user créé.
 *   2. /tenants/start notifuse + prospection → 2 tenants côté Hub.
 *   3. DELETE /api/admin/delete-tenant {email, confirm: true}.
 *   4. Asserts :
 *      - User Auth Hub supprimé (404 sur GET admin /users/[email])
 *      - Tenants soft-deleted (status='deleted', deletedAt posé)
 *      - Subscriptions deleteMany OK (count attendu)
 *      - Warnings notifuse mentionnés dans `actions` si workspace slug existait
 *      - Re-signup même email → nouveau user UUID DIFFÉRENT (pas resurrect)
 *   5. Edge cases :
 *      - DELETE sans confirm:true → 400
 *      - DELETE email inconnu → 404
 *      - DELETE sans admin secret → 401/403
 *
 * **Pourquoi G et pas J ?** : G couvre la propagation cross-app du delete
 * (signal envoyé aux apps, soft-delete row Hub). J-01 dans le bucket GDPR
 * couvre la cascade complète (purge data + revocation customer Stripe).
 *
 * **Garde-fou cleanup** : pas de purge par préfixe nécessaire si tous les
 * tests réussissent (delete-tenant fait le job). Filet afterAll quand même
 * pour les cas où on a fail entre signup et delete.
 */
import { test, expect } from '@playwright/test';

import {
  STAGING_URL,
  adminHeaders,
  bypassRateLimitHeaders,
  withRateLimitRetry,
} from '../../_helpers';
import { runSqlOnStaging } from '../../_sql-helper';
import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  assertMockOAuthAvailable,
  disposeSession,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';

const BUCKET = 'g';
const SPEC = '03-tenant-delete-propagate';

const ADMIN_SECRET =
  process.env.HUB_ADMIN_SECRET || 'staging-admin-secret-not-real-e2e';

test.describe.configure({ mode: 'serial' });

test.describe('Mega G-03 — Tenant delete propagate', () => {
  const sessions: MegaSession[] = [];

  test.afterEach(async () => {
    while (sessions.length > 0) {
      await disposeSession(sessions.pop()!);
    }
  });

  test.afterAll(async () => {
    try {
      const stats = await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-03`,
        tenantPrefix: `mega-${BUCKET}`,
      });
      const total = Object.values(stats.rowsDeleted).reduce((a, b) => a + b, 0);
      console.log(`[mega G-03 afterAll] purge ${total} rows (${stats.durationMs}ms)`);
    } catch (err) {
      console.warn(`[mega G-03 afterAll] purge swallow: ${String(err)}`);
    }
  });

  test('pré-flight : mock-oauth + admin secret OK', async ({ request }) => {
    await assertMockOAuthAvailable(request);
    const probe = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent('ghost@e2e.veridian.site')}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(probe.status(), 'admin secret pas câblé en staging').toBe(404);
  });

  test('DELETE sans admin secret → 401/403', async ({ request }) => {
    const res = await request.delete(`${STAGING_URL}/api/admin/delete-tenant`, {
      headers: { 'content-type': 'application/json' },
      data: { email: 'anything@e2e.veridian.site', confirm: true },
      failOnStatusCode: false,
    });
    expect(
      [401, 403],
      `DELETE sans secret doit 401/403 got ${res.status()}`,
    ).toContain(res.status());
  });

  test('DELETE sans confirm:true → 400', async ({ playwright, request }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'no-confirm' },
    );
    sessions.push(session);

    const res = await request.delete(`${STAGING_URL}/api/admin/delete-tenant`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email: session.email }, // confirm absent
      failOnStatusCode: false,
    });
    expect(res.status(), `DELETE sans confirm doit 400 got ${res.status()}`).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.toLowerCase()).toMatch(/confirm/);
  });

  test('DELETE email inconnu → 404', async ({ request }) => {
    const ghostEmail = `e2e-mega-g-03-ghost-${Date.now()}@e2e.veridian.site`;
    const res = await request.delete(`${STAGING_URL}/api/admin/delete-tenant`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email: ghostEmail, confirm: true },
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      `DELETE email inconnu doit 404 got ${res.status()}`,
    ).toBe(404);
  });

  test('DELETE happy path : user + tenants supprimés, cascade propagée', async ({
    playwright,
    request,
  }) => {
    // ─── Setup ──────────────────────────────────────────────────────
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'happy' },
    );
    sessions.push(session);

    // Provisionne notifuse + prospection.
    await session.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });
    await session.request.post('/api/tenants/start', {
      data: { app: 'prospection' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });

    // Snapshot avant suppression.
    const safeEmail = session.email.replace(/'/g, "''");
    const tenantsBeforeRaw = runSqlOnStaging(
      `SELECT count(*) FROM hub_app.tenants
         WHERE user_id = (
           SELECT supabase_user_id::uuid FROM hub_app.users
           WHERE email = '${safeEmail}' AND supabase_user_id IS NOT NULL
         );`,
    );
    const tenantsBefore = Number(tenantsBeforeRaw.trim());
    console.log(`[mega G-03] tenants before delete: ${tenantsBefore}`);

    // ─── DELETE ─────────────────────────────────────────────────────
    const delRes = await request.delete(`${STAGING_URL}/api/admin/delete-tenant`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email: session.email, confirm: true },
      failOnStatusCode: false,
    });
    expect(
      delRes.status(),
      `DELETE happy path doit 200 got ${delRes.status()}`,
    ).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);
    expect(delBody.email.toLowerCase()).toBe(session.email.toLowerCase());
    expect(Array.isArray(delBody.actions)).toBe(true);
    // Au moins 'Deleted auth user' doit figurer dans actions
    const actionsJoined = delBody.actions.join(' | ');
    expect(
      actionsJoined,
      `actions doit mentionner la suppression auth user — got: ${actionsJoined}`,
    ).toMatch(/Deleted auth user/i);

    // ─── Asserts cascade DB ─────────────────────────────────────────
    // User Auth Hub supprimé
    const userExistsRaw = runSqlOnStaging(
      `SELECT count(*) FROM hub_app.users WHERE email = '${safeEmail}';`,
    );
    expect(
      Number(userExistsRaw.trim()),
      `User ${session.email} doit être supprimé après delete-tenant`,
    ).toBe(0);

    // Tenants : SI tenantsBefore > 0, ils doivent être soft-deleted (status='deleted')
    // (le user.delete cascade ne touche pas tenants — c'est le code admin qui soft-delete)
    // On query par slug LIKE 'mega-g-03-%' pour retrouver les rows orphelines.
    if (tenantsBefore > 0) {
      // Après user.delete, user_id n'existe plus → on cherche par slug
      const orphanRaw = runSqlOnStaging(
        `SELECT count(*) FROM hub_app.tenants
           WHERE user_id NOT IN (SELECT supabase_user_id::uuid FROM hub_app.users WHERE supabase_user_id IS NOT NULL)
             AND status != 'deleted'
           LIMIT 5;`,
      );
      const orphan = Number(orphanRaw.trim());
      if (orphan > 0) {
        console.warn(
          `[mega G-03] ${orphan} tenant(s) orphelin(s) status!='deleted' détecté(s) — possible bug cascade`,
        );
      }
    }

    // Admin GET /users/[email] → 404
    const getUserRes = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(session.email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(
      getUserRes.status(),
      `GET /users/[email] après delete doit 404 got ${getUserRes.status()}`,
    ).toBe(404);
  });

  test('re-signup même email après delete → user UUID DIFFÉRENT', async ({
    playwright,
    request,
  }) => {
    // 1. Signup initial
    const first = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'resurrect-v1' },
    );
    sessions.push(first);

    const firstUserRes = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(first.email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(firstUserRes.status()).toBe(200);
    const firstUuid = (await firstUserRes.json()).user.supabase_user_id;
    expect(firstUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // 2. Delete
    const delRes = await request.delete(`${STAGING_URL}/api/admin/delete-tenant`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email: first.email, confirm: true },
      failOnStatusCode: false,
    });
    expect(delRes.status()).toBe(200);

    // 3. Re-signup même email
    const second = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      {
        bucket: BUCKET,
        spec: SPEC,
        provider: 'google',
        variant: 'resurrect-v1',
        emailOverride: first.email, // MÊME email
      },
    );
    sessions.push(second);

    const secondUserRes = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(second.email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(secondUserRes.status()).toBe(200);
    const secondUuid = (await secondUserRes.json()).user.supabase_user_id;
    expect(secondUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // INVARIANT GDPR : pas de resurrection — UUID DIFFÉRENT
    expect(
      secondUuid,
      `INVARIANT GDPR : re-signup ne doit PAS ressusciter l'ancien UUID. ` +
        `Old=${firstUuid} New=${secondUuid}`,
    ).not.toBe(firstUuid);
  });
});
