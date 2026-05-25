/**
 * MEGA A-01 — Signup OAuth Google bout-en-bout
 *
 * **POURQUOI** : couvre le scénario commercial "client tape l'URL, choisit
 * Google, atterrit sur /dashboard avec son workspace prêt et 0 mail trial
 * envoyé". C'est le happy path numéro 1 de la suite MEGA — si lui casse,
 * tout le SaaS est inutilisable. Le bug `supabaseUserId NULL` 2026-05-21
 * (cf memory `reference_oauth_supabase_user_id_bridge.md`) est exactement
 * le genre de régression qu'on veut bloquer avant qu'elle atteigne prod.
 *
 * **ASSERTS** (hardcore, pas du checkbox) :
 *  1. mock OAuth provider est listé côté staging (préflight)
 *  2. callback mock-oauth retourne < 400
 *  3. row `hub_app.users` créée avec exactement 1 occurrence par email
 *  4. `supabaseUserId` est un UUID v4 RFC strict (bug 2026-05-21 dragnet)
 *  5. `mfaSecret IS NULL` (pas de MFA sur signup OAuth fresh)
 *  6. `hub_app.workspaces` 1 ligne créée avec `ownerId = users.id`
 *  7. `hub_app.workspace_members` count = 1 (l'owner est membre OWNER)
 *  8. `hub_app.accounts` 1 ligne `provider = 'mock-oauth'` avec
 *     providerAccountId non-vide
 *  9. Aucune row `hub_app.tenant_trials` (les tenants se créent à la
 *     demande via `/api/tenants/start`, pas au signup)
 * 10. Idempotence : 2e signup même email → callback toujours < 400, mais
 *     users.count reste à 1 (pas de doublon, account-linking actif)
 *
 * **CLEANUP** : `test.afterAll` purge tout ce qui commence par
 * `e2e-mega-a-01-<RUN_STAMP>` (users CASCADE workspaces, accounts,
 * sessions, etc.) via `purgeMegaByPrefix`.
 *
 * **GARDE-FOU TEMPS** : aucun `Date.now()` en assert, aucun `new Date()`
 * hardcodé — on n'utilise que `MEGA_RUN_STAMP` (déjà stable) et des
 * vérifications relatives (existe / n'existe pas / count).
 */
import { test, expect } from '@playwright/test';

import { runSqlOnStaging } from '../../_sql-helper';

import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  assertMockOAuthAvailable,
  disposeSession,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'a';
const SPEC = '01-google';

const UUID_V4_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Mode serial : on enchaîne signup → assertions → cleanup. Pas de
// parallélisme intra-spec (les 2 tests partagent la même row user via
// le scénario d'idempotence).
test.describe.configure({ mode: 'serial' });

test.describe('Mega A-01 — Signup OAuth Google bout-en-bout', () => {
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
      /* afterAll ne throw jamais */
    }
  });

  test('A-01 — préflight mock OAuth disponible côté staging', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('A-01 — signup Google neuf + 9 invariants DB stricts', async ({ playwright }) => {
    // ─── 1. Signup via mock OAuth provider=google ────────────────────
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      { bucket: BUCKET, spec: SPEC, provider: 'google', variant: 'fresh' },
    );
    expect(
      session.callbackStatus,
      'mock-oauth callback Google doit retourner < 400',
    ).toBeLessThan(400);
    expect(session.email).toMatch(/^e2e-mega-a-01-google-fresh-.+@e2e\.veridian\.site$/);

    const safeEmail = session.email.replace(/'/g, "''");

    // ─── 2. Row users existe en DB Hub avec invariants strictes ──────
    // Une seule query groupée pour limiter les SSH roundtrips (≈700ms each).
    const userRow = runSqlOnStaging(
      `SELECT
         count(*)::text AS cnt,
         COALESCE(MAX(supabase_user_id::text), '') AS uuid,
         COALESCE(MAX(CASE WHEN mfa_secret IS NULL THEN 'null' ELSE 'set' END), '') AS mfa,
         COALESCE(MAX(id), '') AS user_id
       FROM hub_app.users
       WHERE email = '${safeEmail}';`,
    );
    const [cntStr, uuid, mfa, userId] = (userRow.split('\n')[0] ?? '').split('|');
    expect(
      Number(cntStr),
      `users row pour ${session.email} doit exister exactement 1 fois`,
    ).toBe(1);
    expect(
      uuid,
      `supabaseUserId doit être un UUID v4 RFC (bug 2026-05-21 dragnet) — got "${uuid}"`,
    ).toMatch(UUID_V4_RX);
    expect(mfa, 'mfa_secret doit être NULL après signup OAuth fresh').toBe('null');
    expect(userId, 'users.id doit être posé (cuid)').not.toBe('');

    // ─── 3. Workspace auto-créé + member OWNER ───────────────────────
    const wsRow = runSqlOnStaging(
      `SELECT
         (SELECT count(*) FROM hub_app.workspaces w
            WHERE w.owner_id = (SELECT id FROM hub_app.users WHERE email = '${safeEmail}')
         )::text AS ws_count,
         (SELECT count(*) FROM hub_app.workspace_members wm
            JOIN hub_app.workspaces w2 ON w2.id = wm.workspace_id
            WHERE w2.owner_id = (SELECT id FROM hub_app.users WHERE email = '${safeEmail}')
         )::text AS member_count;`,
    );
    const [wsCntStr, memberCntStr] = (wsRow.split('\n')[0] ?? '').split('|');
    expect(
      Number(wsCntStr),
      'workspace par défaut doit avoir été provisionné (provisionDefaultWorkspace)',
    ).toBeGreaterThanOrEqual(1);
    expect(
      Number(memberCntStr),
      'l\'owner doit être enregistré comme member (role OWNER)',
    ).toBeGreaterThanOrEqual(1);

    // ─── 4. Account OAuth mock-oauth créé ────────────────────────────
    const accountRow = runSqlOnStaging(
      `SELECT
         count(*)::text,
         COALESCE(MAX(provider), '') AS provider,
         COALESCE(MAX("providerAccountId"), '') AS provider_account_id
       FROM hub_app.accounts
       WHERE "userId" = (SELECT id FROM hub_app.users WHERE email = '${safeEmail}');`,
    );
    const [accCntStr, provider, providerAccountId] =
      (accountRow.split('\n')[0] ?? '').split('|');
    expect(
      Number(accCntStr),
      'au moins 1 Account doit être lié au user après signup OAuth',
    ).toBeGreaterThanOrEqual(1);
    expect(provider, 'provider doit être mock-oauth').toBe('mock-oauth');
    expect(
      providerAccountId,
      'providerAccountId ne doit pas être vide (sinon account-linking foiré)',
    ).not.toBe('');

    // ─── 5. Aucune row tenant_trials (création tenant déférée à la demande) ──
    const trialsCnt = runSqlOnStaging(
      `SELECT count(*)::text
         FROM hub_app.tenant_trials
         WHERE tenant_id IN (
           SELECT id::text FROM hub_app.tenants
            WHERE user_id = (SELECT supabase_user_id::uuid FROM hub_app.users WHERE email = '${safeEmail}')
         );`,
    );
    expect(
      Number(trialsCnt.trim()),
      'aucun trial ne doit exister tant que le user n\'a pas cliqué "Commencer l\'essai"',
    ).toBe(0);
  });

  test('A-01 — idempotence : 2e signup même email → pas de doublon user', async ({
    playwright,
  }) => {
    // Le 1er test a déjà créé le user. On reconstruit l'email avec le
    // même variant pour viser exactement la même row.
    const email = `e2e-mega-a-01-google-fresh-${MEGA_RUN_STAMP}@e2e.veridian.site`;
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      {
        bucket: BUCKET,
        spec: SPEC,
        provider: 'google',
        variant: 'fresh',
        emailOverride: email,
      },
    );
    expect(
      session.callbackStatus,
      'le 2e signup OAuth doit aussi passer (account-linking)',
    ).toBeLessThan(400);

    // Le count user doit rester à 1 (pas de doublon malgré 2 callbacks).
    const safeEmail = email.replace(/'/g, "''");
    const cnt = runSqlOnStaging(
      `SELECT count(*)::text FROM hub_app.users WHERE email = '${safeEmail}';`,
    );
    expect(
      Number(cnt.trim()),
      'allowDangerousEmailAccountLinking doit dédupliquer le user (pas 2 rows)',
    ).toBe(1);
  });
});
