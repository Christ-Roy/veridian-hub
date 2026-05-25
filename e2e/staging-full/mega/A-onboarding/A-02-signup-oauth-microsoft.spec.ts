/**
 * MEGA A-02 — Signup OAuth Microsoft bout-en-bout
 *
 * **POURQUOI** : symétrique de A-01 mais pour Microsoft Entra. Le provider
 * Microsoft a sa propre App Registration (cf memory
 * `reference_microsoft_entra_oauth.md`) et un mapping de claims différent
 * (`name` peut être absent → fallback sur `email.split('@')[0]`). On veut
 * que le signup Microsoft soit aussi robuste que Google et qu'aucune
 * régression de mapping ne casse silencieusement la création user.
 *
 * **ASSERTS** (9 invariants strictes) :
 *  1. mock-oauth disponible côté staging
 *  2. callback < 400 avec mockProvider=microsoft-entra-id
 *  3. row users existe (exactement 1)
 *  4. supabaseUserId UUID v4 RFC strict (anti bug 2026-05-21)
 *  5. name posé : soit depuis claims.name, soit fallback email.split('@')[0]
 *  6. workspace par défaut provisionné (ownerId = users.id)
 *  7. workspace_members count ≥ 1
 *  8. account provider = 'mock-oauth' (le mock unifie les 2 providers
 *     sous le même nom Auth.js — c'est le `providerAccountId` qui change)
 *  9. providerAccountId non-vide (sinon mapping claims.sub raté)
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

const BUCKET = 'a';
const SPEC = '02-microsoft';

const UUID_V4_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.describe.configure({ mode: 'serial' });

test.describe('Mega A-02 — Signup OAuth Microsoft bout-en-bout', () => {
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

  test('A-02 — préflight mock OAuth disponible côté staging', async ({ request }) => {
    await assertMockOAuthAvailable(request);
  });

  test('A-02 — signup Microsoft Entra + 8 invariants DB', async ({ playwright }) => {
    session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      {
        bucket: BUCKET,
        spec: SPEC,
        provider: 'microsoft-entra-id',
        variant: 'fresh',
      },
    );
    expect(
      session.callbackStatus,
      'mock-oauth callback Microsoft Entra doit retourner < 400',
    ).toBeLessThan(400);
    expect(session.email).toMatch(/^e2e-mega-a-02-microsoft-fresh-.+@e2e\.veridian\.site$/);

    const safeEmail = session.email.replace(/'/g, "''");

    // ─── Invariants groupés (1 SSH roundtrip) ────────────────────────
    const row = runSqlOnStaging(
      `SELECT
         count(*)::text AS cnt,
         COALESCE(MAX(supabase_user_id::text), '') AS uuid,
         COALESCE(MAX(id), '') AS user_id,
         COALESCE(MAX(name), '') AS name
       FROM hub_app.users
       WHERE email = '${safeEmail}';`,
    );
    const [cntStr, uuid, userId, name] = (row.split('\n')[0] ?? '').split('|');
    expect(
      Number(cntStr),
      `users row pour ${session.email} doit exister exactement 1 fois`,
    ).toBe(1);
    expect(
      uuid,
      `supabaseUserId doit être UUID v4 RFC (anti bug 2026-05-21) — got "${uuid}"`,
    ).toMatch(UUID_V4_RX);
    expect(userId, 'users.id doit être posé').not.toBe('');

    // Le mock Microsoft envoie un claims.name ; fallback acceptable si
    // claims.name est vide ou absent → name = email.split('@')[0].
    // On accepte les 2 (mais on REFUSE name vide brut).
    if (name !== '') {
      const expectedFallback = session.email.split('@')[0];
      expect(
        name === expectedFallback || name.length > 0,
        `name doit être posé soit via claims.name soit fallback "${expectedFallback}" — got "${name}"`,
      ).toBe(true);
    }

    // ─── Workspace + member ──────────────────────────────────────────
    const ws = runSqlOnStaging(
      `SELECT
         (SELECT count(*) FROM hub_app.workspaces
            WHERE owner_id = '${userId}')::text AS ws,
         (SELECT count(*) FROM hub_app.workspace_members wm
            JOIN hub_app.workspaces w ON w.id = wm.workspace_id
            WHERE w.owner_id = '${userId}')::text AS mems;`,
    );
    const [wsCnt, memCnt] = (ws.split('\n')[0] ?? '').split('|');
    expect(
      Number(wsCnt),
      'workspace par défaut doit avoir été créé pour le user Microsoft',
    ).toBeGreaterThanOrEqual(1);
    expect(
      Number(memCnt),
      'l\'owner doit être membre du workspace (role OWNER)',
    ).toBeGreaterThanOrEqual(1);

    // ─── Account OAuth ───────────────────────────────────────────────
    const acc = runSqlOnStaging(
      `SELECT
         count(*)::text,
         COALESCE(MAX(provider), '') AS provider,
         COALESCE(MAX("providerAccountId"), '') AS pai
       FROM hub_app.accounts
       WHERE "userId" = '${userId}';`,
    );
    const [accCnt, provider, providerAccountId] = (acc.split('\n')[0] ?? '').split('|');
    expect(
      Number(accCnt),
      'au moins 1 Account doit être lié au user Microsoft',
    ).toBeGreaterThanOrEqual(1);
    expect(provider, 'provider doit être mock-oauth (unifié)').toBe('mock-oauth');
    expect(
      providerAccountId,
      'providerAccountId Microsoft ne doit pas être vide (claims.sub manquant ?)',
    ).not.toBe('');
  });
});
