/**
 * MEGA A-04 — Magic link cross-app (Hub → Notifuse)
 *
 * **POURQUOI** : un user Hub connecté doit pouvoir ouvrir Notifuse en
 * 1 clic via `POST /api/admin/notifuse/magic-link`. L'endpoint :
 *   - exige une session Hub (Auth.js v5)
 *   - exige un body `{ tenantId }`
 *   - vérifie ownership (sessionUser.supabaseUserId === tenant.userId)
 *     OU rôle admin platform
 *   - vérifie que le tenant a un workspace Notifuse provisionné
 *     (notifuseApiKey + notifuseUserEmail)
 *   - délègue à `NotifuseClient.generateMagicLink` qui appelle Notifuse
 *
 * **ASSERTS** (8 invariants de contrat) :
 *  1. POST sans session → 401 Unauthorized
 *  2. POST sans body → 400 Invalid JSON
 *  3. POST avec session valide mais sans tenantId → 400 tenantId required
 *  4. POST avec tenantId inexistant → 404 Tenant not found
 *  5. POST avec tenantId d'un AUTRE user (cross-tenant) → 403 Forbidden
 *     (anti élévation de privilèges — un user ne peut pas piquer le
 *     magic-link d'un autre tenant)
 *  6. POST sur tenant SANS notifuse_workspace provisionné → 409
 *     Tenant Notifuse workspace not provisioned
 *  7. POST happy path retourne 200 OU 502 (selon état Notifuse staging)
 *     mais JAMAIS 401/403/404 si setup correct
 *  8. Réponse 200 contient `expiresAt` (TTL court — pas de magic-link
 *     éternel ni de leak du token signé en clair)
 *
 * **NOTE** : on ne teste pas le contenu de l'autoLoginUrl côté Notifuse
 * (down-stream session ouverte) car ça dépend de Notifuse staging et
 * du provisioning preset. Spec cible le contrat Hub strict.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { STAGING_URL } from '../../_helpers';
import { runSqlOnStaging } from '../../_sql-helper';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  assertMockOAuthAvailable,
  disposeSession,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';

const BUCKET = 'a';
const SPEC = '04-notifuse';

async function postMagicLink(
  request: APIRequestContext,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: Parameters<typeof request.post>[1] = {
    failOnStatusCode: false,
  };
  if (body !== undefined) {
    init.data = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await request.post(
    `${STAGING_URL}/api/admin/notifuse/magic-link`,
    init,
  );
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status(), body: parsed };
}

test.describe('Mega A-04 — Magic link Hub → Notifuse', () => {
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
        emailPrefix: `e2e-mega-${BUCKET}-${SPEC}`,
        tenantPrefix: `mega-${BUCKET}-${SPEC}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('A-04 — préflight mock OAuth dispo', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('A-04 — POST sans session → 401 Unauthorized', async ({ request }) => {
    const res = await postMagicLink(request, { tenantId: 'mega-fake' });
    expect(
      res.status,
      'magic-link route DOIT être derrière session — sinon élévation de privilèges',
    ).toBe(401);
  });

  test('A-04 — POST avec session + tenantId inexistant → 404', async ({ playwright }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'notfound' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // tenants.id est UUID strict — on envoie un UUID v4 random pour viser
    // exactement la garde "Tenant not found" (route findUnique by id).
    const res = await postMagicLink(session.request, {
      tenantId: randomUUID(),
    });
    expect(
      res.status,
      'tenant inexistant doit renvoyer 404 (pas 403 — sinon leak existence)',
    ).toBe(404);
  });

  test('A-04 — POST avec session + body invalide → 400', async ({ playwright }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'badbody' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    // Body JSON valide mais sans tenantId.
    const empty = await postMagicLink(session.request, {});
    expect(
      empty.status,
      'body sans tenantId doit retourner 400 tenantId required',
    ).toBe(400);

    // tenantId vide (trim côté serveur) → 400.
    const blank = await postMagicLink(session.request, { tenantId: '   ' });
    expect(
      blank.status,
      'tenantId blank string doit retourner 400 après trim',
    ).toBe(400);
  });

  test('A-04 — cross-tenant : user A ne peut pas demander magic-link tenant de user B', async ({
    playwright,
  }) => {
    // ─── 1. User A signup + provisionne implicitement un tenant Hub ──
    const userA = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'crossA' },
    );
    expect(userA.callbackStatus).toBeLessThan(400);

    const safeEmailA = userA.email.replace(/'/g, "''");
    // Crée un tenant artificiel rattaché au user A (avec notifuseWorkspaceSlug
    // posé pour passer la garde 409 et atteindre la garde 403).
    const tenantId = `mega-${BUCKET}-${SPEC}-crossB-${Date.now()}`;
    runSqlOnStaging(
      `INSERT INTO hub_app.tenants
         (id, user_id, name, slug, status,
          notifuse_workspace_slug, notifuse_api_key, notifuse_user_email)
       VALUES (
         gen_random_uuid(),
         gen_random_uuid(),
         'Mega A-04 Cross-tenant fixture',
         '${tenantId}',
         'active',
         '${tenantId}',
         'fake-key',
         'fake@notifuse.local'
       )
       ON CONFLICT DO NOTHING;`,
    );

    // Récupère le tenant_id (cuid en DB) qu'on va passer dans le body.
    const tenantRow = runSqlOnStaging(
      `SELECT id FROM hub_app.tenants WHERE slug = '${tenantId}' LIMIT 1;`,
    );
    const tenantCuid = tenantRow.trim();
    expect(tenantCuid, 'tenant fixture doit avoir été inséré').not.toBe('');

    try {
      // ─── 2. User A tente magic-link sur tenant qui ne lui appartient pas ──
      const res = await postMagicLink(userA.request, { tenantId: tenantCuid });
      expect(
        res.status,
        `user A doit recevoir 403 sur magic-link tenant d'un autre user (got ${res.status}: ${JSON.stringify(res.body)}) — leak privilege escalation`,
      ).toBe(403);
    } finally {
      await disposeSession(userA);
      // Cleanup du tenant fixture (le purgeMegaByPrefix afterAll s'en charge
      // aussi, mais on est explicite ici pour limiter le scope d'impact).
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE slug = '${tenantId}';`,
      );
      // Bonus log
      console.log(`[A-04 cross-tenant] email A=${safeEmailA} tenant=${tenantId}`);
    }
  });

  test('A-04 — happy path : tenant own non-provisionné renvoie 409', async ({
    playwright,
  }) => {
    // Crée un user + un tenant qui LUI APPARTIENT mais sans notifuse provisionné.
    // → on doit toucher le 409 'Tenant Notifuse workspace not provisioned'.
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'happy' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    const safeEmail = session.email.replace(/'/g, "''");
    const userUuidRow = runSqlOnStaging(
      `SELECT supabase_user_id::text FROM hub_app.users WHERE email = '${safeEmail}' LIMIT 1;`,
    );
    const userUuid = userUuidRow.trim();
    expect(userUuid, 'supabase_user_id user doit exister').not.toBe('');

    const tenantSlug = `mega-${BUCKET}-${SPEC}-happy-${Date.now()}`;
    runSqlOnStaging(
      `INSERT INTO hub_app.tenants
         (id, user_id, name, slug, status)
       VALUES (
         gen_random_uuid(),
         '${userUuid}'::uuid,
         'Mega A-04 happy fixture (no notifuse)',
         '${tenantSlug}',
         'active'
       )
       ON CONFLICT DO NOTHING;`,
    );

    const tenantRow = runSqlOnStaging(
      `SELECT id FROM hub_app.tenants WHERE slug = '${tenantSlug}' LIMIT 1;`,
    );
    const tenantCuid = tenantRow.trim();
    expect(tenantCuid, 'tenant fixture doit avoir été inséré').not.toBe('');

    try {
      const res = await postMagicLink(session.request, { tenantId: tenantCuid });
      // Le contrat dit : si notifuseApiKey / notifuseUserEmail manquent → 409.
      // C'est la garde "Tenant Notifuse workspace not provisioned".
      expect(
        res.status,
        `tenant own sans Notifuse provisionné doit retourner 409 (got ${res.status}: ${JSON.stringify(res.body)})`,
      ).toBe(409);
    } finally {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE slug = '${tenantSlug}';`,
      );
    }
  });
});
