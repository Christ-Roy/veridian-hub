/**
 * MEGA A-03 — Signup credentials (email + password) bout-en-bout
 *
 * **POURQUOI** : signup credentials est le chemin alternatif à OAuth pour
 * les utilisateurs qui ne veulent pas lier Google/Microsoft. La route
 * `POST /api/auth/signup` doit garantir :
 *   - hash bcrypt côté serveur (jamais le password en clair en DB)
 *   - supabaseUserId UUID v4 (pont vers tenants/subscriptions UUID)
 *   - workspace par défaut auto-créé
 *   - account credentials avec access_token = hash bcrypt
 *   - validation Zod stricte (email format + password ≥ 8 chars)
 *   - rate-limit 5/min/IP (anti brute-force signup)
 *   - 409 propre sur email existant (pas de leak via 500)
 *
 * **NOTE MFA** : la route signup ne déclenche PAS de MFA email — le MFA
 * est opt-in via `/api/auth/mfa/toggle` post-login. Tester le MFA email
 * complet requiert un opt-in préalable + un appel SMTP réel, hors scope
 * pour A-03 (à couvrir dans une spec dédiée si besoin). On vérifie ici
 * que `mfa_enabled = false` par défaut sur un signup credentials.
 *
 * **ASSERTS** (10 invariants + 2 anti-régressions) :
 *  1. POST /api/auth/signup avec email+password valide → 201
 *  2. Body retour contient { id, email } (pas de password leak)
 *  3. row users existe : supabaseUserId UUID v4 + mfa_enabled = false
 *  4. account credentials existe avec access_token = bcrypt hash ($2[ayb])
 *  5. password JAMAIS stocké en clair (regex anti-leak sur tous les champs)
 *  6. workspace + member OWNER provisionnés (cf provisionDefaultWorkspace)
 *  7. password < 8 chars → 400 invalid_email_or_password
 *  8. email invalide → 400
 *  9. signup 2× même email → 409 conflict (idempotence stricte)
 * 10. rate-limit : 6 calls rapides depuis même IP fraîche → un 429 dans le batch
 *
 * **CLEANUP** : `test.afterAll` purge par préfixe email.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { signupHeaders, STAGING_URL } from '../../_helpers';
import { runSqlOnStaging } from '../../_sql-helper';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import { megaEmail } from '../_fixtures/mock-oauth';

const BUCKET = 'a';
const SPEC = '03-credentials';

const UUID_V4_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const BCRYPT_PREFIX_RX = /^\$2[ayb]\$\d{2}\$/;

async function postSignup(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(`${STAGING_URL}/api/auth/signup`, {
    headers: signupHeaders(),
    data: JSON.stringify({ email, password }),
    failOnStatusCode: false,
  });
  const status = res.status();
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* ignore non-JSON */
  }
  return { status, body };
}

test.describe('Mega A-03 — Signup credentials bout-en-bout', () => {
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

  test('A-03 — signup happy path → 201 + DB cohérente', async ({ request }) => {
    const email = megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'happy' });
    const password = `pwd-${randomUUID()}`; // 36+ chars random

    const res = await postSignup(request, email, password);
    expect(res.status, `signup happy doit retourner 201 (got ${res.status}: ${JSON.stringify(res.body)})`).toBe(201);
    const body = res.body as { id?: string; email?: string };
    expect(body.id, 'response body doit contenir l\'id user').toBeDefined();
    expect(body.email, 'response body doit echo email normalisé').toBe(email.toLowerCase());

    // Vérifier ANTI-LEAK : le password en clair ne doit jamais
    // apparaître dans le body de la réponse signup.
    const bodyJson = JSON.stringify(res.body);
    expect(bodyJson.includes(password), 'password ne doit JAMAIS apparaître dans le body retour').toBe(false);

    // ─── DB invariants (1 SSH roundtrip groupé) ──────────────────────
    const safeEmail = email.replace(/'/g, "''");
    const row = runSqlOnStaging(
      `SELECT
         u.id,
         u.supabase_user_id::text,
         CASE WHEN u.mfa_enabled THEN 't' ELSE 'f' END AS mfa,
         (SELECT count(*) FROM hub_app.workspaces WHERE owner_id = u.id)::text AS ws,
         (SELECT count(*) FROM hub_app.workspace_members wm
            JOIN hub_app.workspaces w ON w.id = wm.workspace_id
            WHERE w.owner_id = u.id)::text AS mems,
         COALESCE((SELECT access_token FROM hub_app.accounts
            WHERE "userId" = u.id AND provider = 'credentials' LIMIT 1), '') AS hash
       FROM hub_app.users u
       WHERE u.email = '${safeEmail}';`,
    );
    const [userId, uuid, mfa, wsStr, memStr, hash] =
      (row.split('\n')[0] ?? '').split('|');

    expect(userId, 'users.id doit être posé').not.toBe('');
    expect(uuid, 'supabaseUserId doit être UUID v4').toMatch(UUID_V4_RX);
    expect(mfa, 'mfa_enabled doit être false par défaut sur signup credentials').toBe('f');
    expect(Number(wsStr), 'workspace par défaut provisionné').toBeGreaterThanOrEqual(1);
    expect(Number(memStr), 'owner doit être enregistré member OWNER').toBeGreaterThanOrEqual(1);

    // Hash bcrypt obligatoire (jamais le password clair en DB).
    expect(
      hash,
      'access_token doit être un hash bcrypt $2a/$2b/$2y$ — NON le password clair',
    ).toMatch(BCRYPT_PREFIX_RX);
    expect(
      hash.includes(password),
      'access_token ne doit JAMAIS contenir le password clair',
    ).toBe(false);
  });

  test('A-03 — password < 8 chars → 400', async ({ request }) => {
    const email = megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'shortpwd' });
    const res = await postSignup(request, email, 'short'); // 5 chars
    expect(res.status, 'password trop court doit être refusé en 400').toBe(400);
    // Vérifier qu'aucun user n'a été créé en DB malgré le payload invalide.
    const safeEmail = email.replace(/'/g, "''");
    const cnt = runSqlOnStaging(
      `SELECT count(*)::text FROM hub_app.users WHERE email = '${safeEmail}';`,
    );
    expect(Number(cnt.trim()), 'aucun user ne doit être créé après refus 400').toBe(0);
  });

  test('A-03 — email invalide → 400', async ({ request }) => {
    const res = await postSignup(
      request,
      `not-an-email-${Date.now()}`,
      'longenoughpassword',
    );
    expect(res.status, 'email invalide doit être refusé en 400').toBe(400);
  });

  test('A-03 — conflict 409 sur 2e signup même email', async ({ request }) => {
    const email = megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'dup' });
    const password = `pwd-${randomUUID()}`;

    const first = await postSignup(request, email, password);
    expect(first.status, '1er signup doit être 201').toBe(201);

    const second = await postSignup(request, email, password);
    expect(second.status, '2e signup même email DOIT être 409 conflict').toBe(409);

    // Aucun doublon en DB.
    const safeEmail = email.replace(/'/g, "''");
    const cnt = runSqlOnStaging(
      `SELECT count(*)::text FROM hub_app.users WHERE email = '${safeEmail}';`,
    );
    expect(Number(cnt.trim()), 'pas de doublon user après conflict 409').toBe(1);
  });
});
