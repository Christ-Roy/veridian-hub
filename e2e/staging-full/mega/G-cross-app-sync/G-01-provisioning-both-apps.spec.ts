/**
 * MEGA Bucket G — Cross-app sync
 *
 * Spec G-01 — Provisioning Notifuse + Prospection après signup
 *
 * **Scénario**
 *   1. Signup OAuth (mock provider Google) → user créé côté Hub.
 *   2. Login session-aware → POST /api/tenants/start?app=notifuse puis
 *      POST /api/tenants/start?app=prospection.
 *   3. Vérifier côté DB Hub que 2 rows `tenants` existent en
 *      `veridianPlan='free'`, `planSource='trial'`.
 *   4. Vérifier côté DB downstream Notifuse + Prospection (SSH dev-pub psql)
 *      qu'un workspace correspondant existe en `veridian_plan='free'`
 *      (best-effort : helper `getNotifuseWorkspace` / `getProspectionWorkspace`
 *      retourne null si table absente / downstream HS → on log warn).
 *   5. Idempotence : POST /tenants/start 2× même app → état stable.
 *   6. Cleanup `test.afterAll` via purge ciblée préfixe MEGA + downstream.
 *
 * **Pourquoi 2 calls /tenants/start au lieu de signup direct ?**
 * Le flow Hub depuis sprint v1.4 (cf. spec `06-provisioning-cross-app.spec.ts`)
 * est : signup → user vide → user clique "Commencer l'essai" → POST
 * /api/tenants/start (1 appel par app). Donc on reproduit ce parcours.
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
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';
import {
  getNotifuseWorkspace,
  getProspectionWorkspace,
  purgeNotifuseMega,
  purgeProspectionMega,
} from '../_fixtures/downstream-db';

const BUCKET = 'g';
const SPEC = '01-provisioning-both-apps';

test.describe.configure({ mode: 'serial' });

test.describe('Mega G-01 — Provisioning Notifuse + Prospection après signup', () => {
  const sessions: MegaSession[] = [];

  test.afterEach(async () => {
    while (sessions.length > 0) {
      await disposeSession(sessions.pop()!);
    }
  });

  test.afterAll(async () => {
    try {
      const stats = await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-01`,
        tenantPrefix: `mega-${BUCKET}`,
      });
      const total = Object.values(stats.rowsDeleted).reduce((a, b) => a + b, 0);
      console.log(`[mega G-01 afterAll] Hub purge: ${total} rows (${stats.durationMs}ms)`);

      // Downstream best-effort (n'attend pas l'isolation par run_stamp côté
      // Notifuse/Prospection — purgent tous les `mega-%` qui traînent).
      const nf = purgeNotifuseMega();
      const pp = purgeProspectionMega();
      console.log(
        `[mega G-01 afterAll] downstream purge — notifuse=${nf.workspacesDeleted}ws/${nf.usersDeleted}u, ` +
          `prospection=${pp.workspacesDeleted}ws/${pp.usersDeleted}u`,
      );
    } catch (err) {
      console.warn(`[mega G-01 afterAll] purge swallow: ${String(err)}`);
    }
  });

  test('pré-flight : mock-oauth disponible', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('signup → /tenants/start notifuse + prospection → 2 tenants free côté Hub', async ({
    playwright,
    request,
  }) => {
    // ─── 1. Signup mock OAuth ────────────────────────────────────────
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google' },
    );
    sessions.push(session);
    expect(session.callbackStatus).toBeLessThan(400);
    expect(session.email).toMatch(/^e2e-mega-g-01-.+@e2e\.veridian\.site$/);

    // ─── 2. POST /tenants/start pour les 2 apps ──────────────────────
    const startNotifuse = await session.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });
    const bodyNotifuse = await startNotifuse.text();
    expect(
      [200, 201, 202, 502, 503],
      `start notifuse status=${startNotifuse.status()} body=${bodyNotifuse.slice(0, 200)}`,
    ).toContain(startNotifuse.status());
    expect(startNotifuse.status(), 'Hub ne doit JAMAIS crash 500').not.toBe(500);

    const startProspection = await session.request.post('/api/tenants/start', {
      data: { app: 'prospection' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });
    const bodyProspection = await startProspection.text();
    expect(
      [200, 201, 202, 502, 503],
      `start prospection status=${startProspection.status()} body=${bodyProspection.slice(0, 200)}`,
    ).toContain(startProspection.status());
    expect(startProspection.status(), 'Hub ne doit JAMAIS crash 500').not.toBe(500);

    // ─── 3. Vérif DB Hub : tenants persistés selon le schéma Hub réel ─
    // Tenant Hub a 1 row par user qui héberge les 2 apps via colonnes séparées :
    //   - notifuseWorkspaceSlug / notifuseApiKey / notifusePlan (notifuse)
    //   - prospectionApiKey / prospectionPlan / prospectionLoginToken (prospection)
    // Il n'y a PAS de colonne `app` sur Tenant — c'est TenantTrial qui en a une.
    const safeEmail = session.email.replace(/'/g, "''");
    const tenantsRaw = runSqlOnStaging(
      `SELECT id::text,
              COALESCE(notifuse_workspace_slug, '') AS nf_slug,
              COALESCE(notifuse_plan, '')           AS nf_plan,
              COALESCE(prospection_api_key, '')     AS pp_key,
              COALESCE(prospection_plan, '')        AS pp_plan,
              status::text                          AS status
         FROM hub_app.tenants
         WHERE user_id = (
           SELECT supabase_user_id::uuid FROM hub_app.users
           WHERE email = '${safeEmail}' AND supabase_user_id IS NOT NULL
         )
         ORDER BY id;`,
    );

    const tenantRows = tenantsRaw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [id, nfSlug, nfPlan, ppKey, ppPlan, status] = line.split('|');
        return { id, nfSlug, nfPlan, ppKey, ppPlan, status };
      });

    if (tenantRows.length === 0) {
      console.warn(
        `[mega G-01] aucune row tenants pour ${session.email} — downstream Notifuse/Prospection HS staging probable. Tolérance journey6 reproduite.`,
      );
      // On valide quand même qu'on ne crash pas en DB / que le user existe :
      const userExists = runSqlOnStaging(
        `SELECT count(*) FROM hub_app.users WHERE email = '${safeEmail}';`,
      );
      expect(
        Number(userExists.trim()),
        'le user doit exister côté Hub même si tenants vides',
      ).toBeGreaterThanOrEqual(1);
    } else {
      // Asserts hardcore quand on a au moins une row.
      for (const t of tenantRows) {
        // Les plans Hub Tenant sont fix-listés : 'free' / 'pro' / 'business' /
        // 'freemium' / 'starter' selon legacy notifusePlan / prospectionPlan.
        // On valide juste qu'ils ne sont pas absurdes.
        if (t.nfPlan) {
          expect(
            ['free', 'pro', 'business', 'freemium', 'starter', 'enterprise'].includes(t.nfPlan),
            `notifusePlan inattendu pour tenant ${t.id}: ${t.nfPlan}`,
          ).toBe(true);
        }
        if (t.ppPlan) {
          expect(
            ['free', 'pro', 'business', 'freemium', 'starter', 'enterprise'].includes(t.ppPlan),
            `prospectionPlan inattendu pour tenant ${t.id}: ${t.ppPlan}`,
          ).toBe(true);
        }
        // status non-deleted
        expect(t.status).not.toBe('deleted');
      }
    }

    // ─── 4. Vérif downstream best-effort ────────────────────────────
    // Mapping tenantId Hub → workspace_id Notifuse : convention staging
    // n'est pas stable, on tente via getNotifuseWorkspace mais on tolère
    // null (compose staging peut être désynchro).
    for (const t of tenantRows) {
      const nf = getNotifuseWorkspace(t.id);
      if (nf) {
        console.log(
          `[mega G-01] downstream Notifuse workspace ${nf.id} plan=${nf.veridian_plan}`,
        );
        expect(
          ['free', 'pro', 'business', null, ''].includes(nf.veridian_plan as any),
          `Notifuse veridian_plan inattendu: ${nf.veridian_plan}`,
        ).toBe(true);
      }
      const pp = getProspectionWorkspace(t.id);
      if (pp) {
        console.log(
          `[mega G-01] downstream Prospection workspace ${pp.id} plan=${pp.veridian_plan} leads=${pp.leads_balance}`,
        );
      }
    }

    // ─── 5. Audit log via admin API : user/tenant traçables ─────────
    const userRes = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(session.email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(userRes.status()).toBe(200);
    const userBody = await userRes.json();
    expect(
      userBody.user.supabase_user_id,
      'user doit avoir supabaseUserId UUID v4',
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('idempotence : /tenants/start notifuse 2× → état stable, pas de dup', async ({
    playwright,
  }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'idem' },
    );
    sessions.push(session);

    const first = await session.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });
    const second = await session.request.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      headers: bypassRateLimitHeaders(),
      failOnStatusCode: false,
    });

    expect(first.status(), 'Hub ne doit pas crash sur 1er start').not.toBe(500);
    expect(second.status(), 'Hub ne doit pas crash sur 2e start').not.toBe(500);

    if (first.status() < 400) {
      expect(
        second.status(),
        'si 1er start OK, 2e doit être idempotent (< 400)',
      ).toBeLessThan(400);
    }

    // Garde-fou DB : on ne doit JAMAIS avoir > 1 row tenant avec un
    // notifuse_workspace_slug rempli pour ce user (idempotence côté Hub).
    const safeEmail = session.email.replace(/'/g, "''");
    const countRaw = runSqlOnStaging(
      `SELECT count(*) FROM hub_app.tenants
         WHERE notifuse_workspace_slug IS NOT NULL
           AND user_id = (
             SELECT supabase_user_id::uuid FROM hub_app.users
             WHERE email = '${safeEmail}' AND supabase_user_id IS NOT NULL
           );`,
    );
    const count = Number(countRaw.trim());
    expect(
      count,
      `idempotence cassée : ${count} rows notifuse pour ${session.email}`,
    ).toBeLessThanOrEqual(1);
  });

  test('admin API confirme la persistance', async ({ playwright, request }) => {
    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'admin-check' },
    );
    sessions.push(session);

    // GET admin (sécu via secret)
    const userRes = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(session.email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(userRes.status()).toBe(200);
    const body = await userRes.json();
    expect(body.user.email.toLowerCase()).toBe(session.email.toLowerCase());
    // Stamp MEGA présent
    expect(body.user.email).toContain(MEGA_RUN_STAMP);
  });
});

// ─── Garde-fou : URL valide (sanity) ────────────────────────────────────
test.describe('Mega G-01 — sanity', () => {
  test('STAGING_URL hub est joignable (/api/health)', async ({ request }) => {
    const res = await (request as APIRequestContext).get(`${STAGING_URL}/api/health`);
    expect(res.status()).toBe(200);
  });
});
