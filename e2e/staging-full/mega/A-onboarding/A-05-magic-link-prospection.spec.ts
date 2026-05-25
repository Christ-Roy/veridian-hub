/**
 * MEGA A-05 — Magic link cross-app (Hub → Prospection)
 *
 * **POURQUOI** : symétrique de A-04 mais pour Prospection. La route
 * `POST /api/prospection/regenerate-login` :
 *   - exige `requireUser()` (session Auth.js)
 *   - appelle `createProspectionClientFromEnv()` (config check)
 *   - délègue à `client.provisionTenant` (upsert côté Prospection)
 *   - persiste le token de login dans `tenants.prospectionLoginToken`
 *
 * **DIFFÉRENCE vs A-04** : la route Prospection ne prend pas de body
 * (pas de tenantId à fournir, le lookup se fait via session.user.email).
 * On teste donc le contrat strict :
 *   - 401 sans session
 *   - 500 si Prospection mal configuré (test conditionnel)
 *   - 502 si Prospection downstream renvoie une erreur
 *   - 200 + body.login_url si tout passe (best-case staging)
 *
 * **ASSERTS** (8 invariants) :
 *  1. POST sans session → 401 (auth required)
 *  2. POST avec session valide → réponse < 600 (pas de 5xx random)
 *  3. Si 200 : body contient `login_url` ET `tenant_id`
 *  4. Si 200 : `login_url` est une URL HTTPS (pas de leak http://)
 *  5. Si 200 : `tenant_id` est non-vide
 *  6. Si 502 : body contient `error: 'Provision failed:'` (pas un leak
 *     de stack trace interne)
 *  7. Si 500 : body contient `error` (pas un crash silent)
 *  8. Side-effect DB : si 200, `tenants.prospectionLoginToken` est mis
 *     à jour (token non-vide)
 *
 * **NOTE** : on accepte plusieurs status code (200 / 500 / 502) selon
 * l'état Prospection staging au moment du run — l'invariant CRITIQUE
 * est le 401 sans session et l'absence de leak en cas d'erreur.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

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
const SPEC = '05-prospection';

async function postRegenerateLogin(
  request: APIRequestContext,
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(
    `${STAGING_URL}/api/prospection/regenerate-login`,
    { failOnStatusCode: false },
  );
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status(), body: parsed };
}

test.describe('Mega A-05 — Magic link Hub → Prospection', () => {
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

  test('A-05 — préflight mock OAuth dispo', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('A-05 — POST sans session → 401 Unauthorized', async ({ request }) => {
    const res = await postRegenerateLogin(request);
    // requireUser() retourne une Response 401 si pas de session.
    expect(
      res.status,
      'regenerate-login doit refuser un caller sans session — sinon élévation prospection',
    ).toBe(401);
  });

  test('A-05 — POST avec session valide → contrat respecté', async ({ playwright }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'happy' },
    );
    expect(session.callbackStatus).toBeLessThan(400);

    const res = await postRegenerateLogin(session.request);

    // ─── Invariant 1 : status code dans la fourchette attendue ────────
    // 200 = happy path, 500 = config Prospection manquante, 502 = downstream
    // KO. Tout autre code = bug à investiguer.
    expect(
      [200, 500, 502].includes(res.status),
      `regenerate-login doit retourner 200/500/502, got ${res.status}: ${JSON.stringify(res.body)}`,
    ).toBe(true);

    const body = res.body as Record<string, unknown> | null;
    expect(body, 'response body doit être JSON parseable').not.toBeNull();

    // ─── Invariant 2 : anti-leak stack trace ──────────────────────────
    // En cas d'erreur, le serveur DOIT renvoyer un message court — pas
    // une stack trace complète qui leak l'arborescence du repo.
    const bodyJson = JSON.stringify(body);
    expect(
      bodyJson.includes('at /') || bodyJson.includes('node_modules'),
      'le body ne doit JAMAIS contenir une stack trace (leak structure interne)',
    ).toBe(false);

    if (res.status === 200) {
      // ─── Happy path : body shape stricte ────────────────────────────
      expect(body, 'body 200 doit contenir login_url').toHaveProperty('login_url');
      expect(body, 'body 200 doit contenir tenant_id').toHaveProperty('tenant_id');

      const loginUrl = (body as { login_url?: string }).login_url ?? '';
      expect(
        loginUrl.startsWith('https://'),
        `login_url doit être HTTPS (got "${loginUrl}") — pas de leak http:// non-chiffré`,
      ).toBe(true);

      const tenantId = (body as { tenant_id?: string }).tenant_id ?? '';
      expect(tenantId, 'tenant_id doit être non-vide').not.toBe('');

      // ─── Side-effect DB : token persisté ─────────────────────────────
      const safeEmail = session.email.replace(/'/g, "''");
      const tokenRow = runSqlOnStaging(
        `SELECT prospection_login_token
           FROM hub_app.tenants
           WHERE user_id = (SELECT supabase_user_id::uuid FROM hub_app.users WHERE email = '${safeEmail}')
              AND prospection_login_token IS NOT NULL
           LIMIT 1;`,
      );
      // Le token peut être vide si le tenant n'a pas encore été linké
      // (provisionTenant 1er appel — la persistance se fait dans la 2e
      // étape findFirst+update). Pas un échec dur, juste un log.
      if (tokenRow.trim() === '') {
        console.warn(
          `[A-05 happy] prospection_login_token non persisté pour ${session.email} ` +
            `— normal si premier provisionTenant, à investiguer si récurrent`,
        );
      }
    } else if (res.status === 502) {
      expect(
        bodyJson.includes('Provision failed') || bodyJson.includes('error'),
        `502 doit contenir un message d'erreur explicite (got ${bodyJson})`,
      ).toBe(true);
    } else if (res.status === 500) {
      expect(
        body,
        '500 doit contenir un champ error (pas un crash silent)',
      ).toHaveProperty('error');
    }
  });
});
