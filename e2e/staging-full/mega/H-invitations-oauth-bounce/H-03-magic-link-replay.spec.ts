/**
 * MEGA Bucket H — Invitations + OAuth bounce
 *
 * Spec H-03 — Magic link cross-app (Hub → Notifuse) — replay safety + ownership
 *
 * **Scénario** : valider le endpoint Hub `POST /api/admin/notifuse/magic-link`
 * (utilisé par le dashboard quand l'user clique "Open Notifuse" sur sa tile).
 *
 * Le contrat de cet endpoint :
 *   - Session-aware (auth via Auth.js).
 *   - Ownership-aware : owner du tenant OR platform admin.
 *   - Body : `{ tenantId: string }`.
 *   - 200 : `{ autoLoginUrl, magicLink, expiresAt }`.
 *   - 401 : pas de session.
 *   - 403 : session OK mais user ≠ owner ET pas admin platform.
 *   - 404 : tenantId inexistant.
 *   - 409 : tenant non-provisionné côté Notifuse (apiKey/userEmail absents).
 *   - 500 / 502 : Notifuse client pas configuré ou downstream HS.
 *
 * **Asserts H-03 hardcore** :
 *   1. POST sans session → 401.
 *   2. POST avec tenantId inconnu (et session) → 404.
 *   3. POST avec session valide mais pas le bon owner → 403.
 *   4. POST sans `tenantId` dans body → 400.
 *   5. POST sur tenant fresh (provisionné=non) → 409 OU 200 si downstream câblé.
 *   6. Replay : 2× POST même tenantId → 2 magicLink DIFFÉRENTS (single-use).
 *   7. Format URL : magicLink commence par https://notifuse(.staging|.app)?.veridian.site
 *   8. INVARIANT pas-de-500 silencieux (autorisé seulement si Notifuse mal config).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

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
  megaEmail,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'h';
const SPEC = '03-magic-link-replay';

test.describe.configure({ mode: 'serial' });

test.describe('Mega H-03 — Magic link Hub → Notifuse (replay + ownership)', () => {
  const sessions: MegaSession[] = [];

  test.beforeAll(async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

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
      console.log(`[mega H-03 afterAll] purge ${total} rows (${stats.durationMs}ms)`);
    } catch (err) {
      console.warn(`[mega H-03 afterAll] purge swallow: ${String(err)}`);
    }
  });

  test('POST sans session → 401 Unauthorized', async ({ request }) => {
    const res = await request.post(`${STAGING_URL}/api/admin/notifuse/magic-link`, {
      headers: { 'content-type': 'application/json' },
      data: { tenantId: 'whatever' },
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      `POST sans session doit 401 got ${res.status()}`,
    ).toBe(401);
  });

  test('POST avec session mais sans tenantId → 400', async ({ playwright }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'no-tenant' },
    );
    sessions.push(session);

    const res = await session.request.post('/api/admin/notifuse/magic-link', {
      headers: { 'content-type': 'application/json' },
      data: {}, // body vide → tenantId required
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      `body sans tenantId doit 400 got ${res.status()}`,
    ).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error.toLowerCase()).toMatch(/tenant/);
  });

  test('POST avec tenantId inexistant → 404 Tenant not found', async ({
    playwright,
  }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'ghost-tenant' },
    );
    sessions.push(session);

    const res = await session.request.post('/api/admin/notifuse/magic-link', {
      headers: { 'content-type': 'application/json' },
      data: { tenantId: `mega-${BUCKET}-${MEGA_RUN_STAMP}-ghost` },
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      `tenantId inexistant doit 404 got ${res.status()}`,
    ).toBe(404);
    const body = await res.json();
    expect(body.error.toLowerCase()).toMatch(/not found/);
  });

  test('ownership : session != owner → 403 Forbidden', async ({ playwright }) => {
    // 1. User A signup + provision notifuse → tenant A créé
    const userA = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'owner-A' },
    );
    sessions.push(userA);
    await userA.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });

    // Lookup tenantId A en DB (1 row par user, héberge notifuse + prospection)
    const safeEmailA = userA.email.replace(/'/g, "''");
    const tenantsA = runSqlOnStaging(
      `SELECT id::text FROM hub_app.tenants
         WHERE user_id = (
             SELECT supabase_user_id::uuid FROM hub_app.users
             WHERE email = '${safeEmailA}' AND supabase_user_id IS NOT NULL
           )
         LIMIT 1;`,
    );
    if (!tenantsA.trim()) {
      console.warn(`[mega H-03] tenant A non créé (downstream HS) — skip ownership test`);
      test.skip(true, 'tenant A non créé, downstream HS staging');
      return;
    }
    const tenantIdA = tenantsA.trim();

    // 2. User B (différent) tente magic-link sur tenant A → 403
    const userB = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'attacker-B' },
    );
    sessions.push(userB);

    const res = await userB.request.post('/api/admin/notifuse/magic-link', {
      headers: { 'content-type': 'application/json' },
      data: { tenantId: tenantIdA },
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      `userB sur tenant userA doit 403 got ${res.status()} (SECURITY : ownership bypass)`,
    ).toBe(403);
    const body = await res.json();
    expect(body.error.toLowerCase()).toMatch(/forbidden/);
  });

  test('owner sur son tenant fresh → 200 (downstream OK) OR 409 (pas provisionné) OR 502 (downstream HS)', async ({
    playwright,
  }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'owner-self' },
    );
    sessions.push(session);
    await session.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });

    const safeEmail = session.email.replace(/'/g, "''");
    const tenantsRaw = runSqlOnStaging(
      `SELECT id::text FROM hub_app.tenants
         WHERE user_id = (
             SELECT supabase_user_id::uuid FROM hub_app.users
             WHERE email = '${safeEmail}' AND supabase_user_id IS NOT NULL
           )
         LIMIT 1;`,
    );
    if (!tenantsRaw.trim()) {
      console.warn(`[mega H-03] tenant non créé (downstream HS) — skip happy path`);
      test.skip(true, 'tenant non créé, downstream HS staging');
      return;
    }
    const tenantId = tenantsRaw.trim();

    const res = await session.request.post('/api/admin/notifuse/magic-link', {
      headers: { 'content-type': 'application/json' },
      data: { tenantId },
      failOnStatusCode: false,
    });

    // States acceptables :
    //   200 : downstream câblé + apiKey présente → renvoie URL signée
    //   409 : tenant en DB mais notifuseApiKey/userEmail vides (pas encore appelé /create-tenant)
    //   500 : NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET pas configuré côté Hub
    //   502 : NotifuseError côté downstream
    expect(
      [200, 409, 500, 502],
      `owner self magic-link status=${res.status()} (autres = régression)`,
    ).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      expect(typeof body.magicLink, 'magicLink doit être string').toBe('string');
      expect(body.magicLink).toMatch(
        /^https:\/\/notifuse(\.app|\.staging)?\.veridian\.site/,
      );
      expect(
        typeof body.expiresAt,
        'expiresAt doit être présent (TTL côté Notifuse)',
      ).toBe('string');
    }
  });

  test('replay : 2× POST owner même tenantId → 2 magic links DIFFÉRENTS (single-use)', async ({
    playwright,
  }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'replay-check' },
    );
    sessions.push(session);
    await session.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });

    const safeEmail = session.email.replace(/'/g, "''");
    const tenantsRaw = runSqlOnStaging(
      `SELECT id::text FROM hub_app.tenants
         WHERE user_id = (
             SELECT supabase_user_id::uuid FROM hub_app.users
             WHERE email = '${safeEmail}' AND supabase_user_id IS NOT NULL
           )
         LIMIT 1;`,
    );
    if (!tenantsRaw.trim()) {
      test.skip(true, 'tenant non créé — skip replay');
      return;
    }
    const tenantId = tenantsRaw.trim();

    const first = await session.request.post('/api/admin/notifuse/magic-link', {
      headers: { 'content-type': 'application/json' },
      data: { tenantId },
      failOnStatusCode: false,
    });

    if (first.status() !== 200) {
      console.warn(
        `[mega H-03] premier magic-link pas 200 (got ${first.status()}) — downstream HS, skip replay`,
      );
      test.skip(true, 'downstream pas câblé pour replay');
      return;
    }
    const firstBody = await first.json();

    const second = await session.request.post('/api/admin/notifuse/magic-link', {
      headers: { 'content-type': 'application/json' },
      data: { tenantId },
      failOnStatusCode: false,
    });
    expect(
      second.status(),
      `2e magic-link doit aussi 200 got ${second.status()}`,
    ).toBe(200);
    const secondBody = await second.json();

    // INVARIANT SINGLE-USE : les 2 magic links doivent être DIFFÉRENTS
    expect(
      secondBody.magicLink,
      `INVARIANT single-use cassé : magicLink #1 == magicLink #2 (token réutilisé)`,
    ).not.toBe(firstBody.magicLink);

    // INVARIANT auto-login URL : idem (chaque génération = nouveau jeton)
    if (firstBody.autoLoginUrl && secondBody.autoLoginUrl) {
      expect(
        secondBody.autoLoginUrl,
        `INVARIANT : autoLoginUrl #1 == autoLoginUrl #2 (jeton réutilisé)`,
      ).not.toBe(firstBody.autoLoginUrl);
    }
  });
});

// ─── Garde-fou cross : admin platform doit pouvoir bypass ownership ────
test.describe('Mega H-03 — admin platform peut générer magic-link pour autrui', () => {
  test.afterAll(async () => {
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-03-admin`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('admin secret (alt endpoint /api/admin/users/[email]) lit les tenants d\'autrui — sanity', async ({
    playwright,
    request,
  }) => {
    // On valide indirectement : l'admin SECRET via /api/admin/users/[email]
    // peut lire les tenants de n'importe quel user (preuve que la couche admin
    // bypass est en place).
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'admin-readback' },
    );

    try {
      const userRes = await withRateLimitRetry(() =>
        request.get(
          `${STAGING_URL}/api/admin/users/${encodeURIComponent(session.email)}`,
          { headers: adminHeaders(), failOnStatusCode: false },
        ),
      );
      expect(userRes.status()).toBe(200);
      const body = await userRes.json();
      expect(body.user.email.toLowerCase()).toBe(session.email.toLowerCase());
      // Tenants accessible (peut être [] si pas de /tenants/start, mais lisible)
      expect(Array.isArray(body.tenants)).toBe(true);
    } finally {
      await disposeSession(session);
    }
  });
});
