/**
 * Journey 15 — Legacy tenants paths (anti-régression code applicatif v1.4).
 *
 * **CONTEXTE** : le sprint v1.4 a livré beaucoup de migrations + backfills :
 *   - 23 users prod ont reçu un workspace via backfill SQL (pas signup classique)
 *   - `supabaseUserId` UUID v4 backfill via event Auth.js (commit `d25f575`)
 *   - Tables nouvelles : `stripe_events`, `webhook_dedup`, `tenant_members`,
 *     `cross_app_invitations`, `tenant_trials`
 *   - Colonne `users.stripe_customer_id` ajoutée (nullable)
 *   - Coexistence webhook Notifuse legacy HMAC + v1.4 Bearer sur la MEME route
 *
 * **QUESTION TESTÉE** : ces vieux tenants prod (backfillés ou pré-sprint v1.4)
 * survivent-ils au code applicatif actuel ? Les chemins legacy fonctionnent-ils
 * toujours sans crash silencieux ?
 *
 * **STRATÉGIE** :
 *   - On crée des users via admin API (équivalent signup propre)
 *   - On corrompt l'état post-création via SQL direct sur la DB staging
 *     (DELETE workspace_members, UPDATE supabase_user_id=NULL, etc.) pour
 *     simuler un tenant pré-backfill
 *   - On observe le comportement du code applicatif face à cet état legacy
 *
 * **5 CAS** :
 *   1. User legacy sans workspace (pré-backfill workspaces v1.4)
 *   2. User legacy sans supabaseUserId (pré-backfill UUID bridge v1.4)
 *   3. Tenant Notifuse avec metadata.notifuse_processed_events legacy
 *   4. User avec Subscription Stripe legacy mais users.stripe_customer_id=NULL
 *   5. Invitation cross-app expirée + tenant soft-deleted (cleanup paths)
 *
 * **CLEANUP** : chaque describe a son `afterAll` qui DELETE les rows créées
 * pour ne pas pourrir la staging DB. Tous les seeds utilisent le préfixe
 * `legacy-e2e-${RUN_STAMP}@...` pour traçabilité.
 *
 * Si un test révèle un bug code → on note `test.fixme(...)` + ticket dans
 * `todo/`. Pas de fix côté agent QA.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';

import {
  STAGING_URL,
  RUN_STAMP,
  adminHeaders,
  bypassRateLimitHeaders,
  freshIpHeader,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';

// ─── Helpers SQL direct via SSH dev-pub ─────────────────────────────────

/**
 * Exécute une requête SQL directement contre `hub-staging-db` via SSH.
 * On utilise psql en mode -t -A et on stream le SQL en stdin pour
 * éviter le quote-hell et la limite ARG_MAX (les payloads metadata
 * peuvent faire plusieurs KB).
 *
 * IMPORTANT : retourne UNIQUEMENT la sortie de la dernière commande SQL.
 * Si le caller envoie plusieurs statements (`;` séparés), il aura le
 * stdout aggrégé. Pour récupérer un RETURNING, faire un seul SELECT
 * via `runSqlSelect`.
 *
 * IMPORTANT 2 : outil de setup/teardown E2E uniquement. Les tests
 * business doivent passer par les API publiques du Hub.
 */
function runSqlOnStaging(sql: string): string {
  // Quotage : on passe le SQL via stdin pour éviter ARG_MAX + double
  // évasion shell. Le `bash -c` distant lit stdin du `ssh`.
  // -X = pas de psqlrc, -q = quiet, -v ON_ERROR_STOP=1 = échec à la 1ère erreur.
  const cmd =
    `ssh -o ConnectTimeout=10 -o BatchMode=yes dev-pub ` +
    `"docker exec -i hub-staging-db psql -U hub -d hub -t -A -X -q -v ON_ERROR_STOP=1"`;
  try {
    return execSync(cmd, {
      timeout: 20_000,
      encoding: 'utf-8',
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[runSqlOnStaging] SQL failed:', sql.slice(0, 500), err);
    throw err;
  }
}

/**
 * Pour les SELECT mono-valeur : strip les éventuels suffixes "INSERT 0 1"
 * etc. qu'un script SQL avec plusieurs statements aurait pu agglomérer.
 * Retourne juste la 1ère ligne non vide.
 */
function runSqlSelectFirst(sql: string): string {
  const out = runSqlOnStaging(sql);
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[0] ?? '';
}

// Secrets HMAC legacy + v1.4
const SECRET_NOTIFUSE_INVITATION =
  process.env.HUB_INVITATION_SECRET_NOTIFUSE ||
  'staging-invitation-secret-notifuse-not-real-e2e';

const NOTIFUSE_HUB_WEBHOOK_SECRET =
  process.env.NOTIFUSE_HUB_WEBHOOK_SECRET ||
  // Fallback : valeur récupérée via `ssh dev-pub 'docker exec hub-staging env'`
  // (stable d'un push à l'autre, injectée par compose staging).
  'a62b5fb7384c9228d9813c5262cb156374c3fb3b6f6f2a3ae4a969657f083683';

const NOTIFUSE_WEBHOOK_TOKEN =
  process.env.NOTIFUSE_WEBHOOK_TOKEN ||
  '6a68be1b9effd251386d0d25d04409cdda75575d79feee3de899c30dfa9b59f2';

function legacyEmail(slug: string): string {
  return makeEmail(`legacy-${slug}`);
}

async function adminCreateUser(
  request: APIRequestContext,
  email: string,
  name: string,
): Promise<{ user_id: string; supabase_user_id: string }> {
  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email, name },
      failOnStatusCode: false,
    }),
  );
  expect(res.status(), `admin create ${email}`).toBe(200);
  return (await res.json()) as { user_id: string; supabase_user_id: string };
}

/** Login via mock OAuth → renvoie un APIRequestContext porteur de session. */
async function mockOauthLogin(
  playwright: typeof import('@playwright/test'),
  email: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const cbRes = await ctx.post('/api/auth/callback/mock-oauth', {
    // Bypass oauthCallbackLimiter (30/min/IP) sur staging E2E.
    headers: bypassRateLimitHeaders(),
    form: {
      csrfToken,
      email,
      mockProvider: 'google',
      mockEmailVerified: 'true',
      callbackUrl: `${STAGING_URL}/dashboard`,
      json: 'true',
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  expect(cbRes.status(), `mock OAuth callback for ${email}`).toBeLessThan(400);

  const sess = await ctx.get('/api/auth/session');
  expect(sess.status()).toBe(200);
  const sessJson = (await sess.json()) as { user?: { email?: string } };
  expect(sessJson.user?.email?.toLowerCase()).toBe(email.toLowerCase());
  return ctx;
}

/**
 * Cleanup helper : DELETE tous les users e2e legacy + leurs workspaces /
 * tenants / subscriptions / cross_app_invitations associés. Idempotent.
 * Appelé en afterAll de chaque describe pour ne pas pourrir staging.
 */
function cleanupLegacyEmails(emails: string[]): void {
  if (emails.length === 0) return;
  const inList = emails
    .map((e) => `'${e.replace(/'/g, "''")}'`)
    .join(',');
  // Cascade : on doit cleaner cross_app_invitations + workspace_members +
  // tenants + subscriptions + tenant_trials avant users (FK).
  //
  // ⚠️ Le tenant_trials.tenant_id peut être soit un UUID Hub, soit un slug
  // Notifuse (cf. helper `resolveOwnerEmail` dans run-tick.ts). On nettoie
  // les 2 paths : (a) via JOIN sur tenants ; (b) via prefix legacy-* pour
  // les orphans (cas où le tenant a déjà été DELETE mais la trial row
  // a survécu — ce qui s'est produit dans la 1ère itération de cette suite).
  const sql = `
    WITH ids AS (
      SELECT id, supabase_user_id FROM hub_app.users WHERE email IN (${inList})
    )
    DELETE FROM hub_app.cross_app_invitations
      WHERE inviter_user_id IN (SELECT id FROM ids)
         OR invitee_email IN (${inList})
         OR accepted_by_user_id IN (SELECT id FROM ids);
    DELETE FROM hub_app.workspace_members
      WHERE user_id IN (SELECT id FROM hub_app.users WHERE email IN (${inList}));
    DELETE FROM hub_app.workspaces
      WHERE owner_id IN (SELECT id FROM hub_app.users WHERE email IN (${inList}));
    DELETE FROM hub_app.tenant_trials
      WHERE tenant_id IN (
        SELECT id::text FROM hub_app.tenants
          WHERE user_id IN (
            SELECT supabase_user_id::uuid FROM hub_app.users
              WHERE email IN (${inList}) AND supabase_user_id IS NOT NULL
          )
      )
      OR tenant_id IN (
        SELECT notifuse_workspace_slug FROM hub_app.tenants
          WHERE user_id IN (
            SELECT supabase_user_id::uuid FROM hub_app.users
              WHERE email IN (${inList}) AND supabase_user_id IS NOT NULL
          )
      )
      OR tenant_id LIKE 'legacy-%-${RUN_STAMP}';
    DELETE FROM hub_app.tenants
      WHERE user_id IN (
        SELECT supabase_user_id::uuid FROM hub_app.users
          WHERE email IN (${inList}) AND supabase_user_id IS NOT NULL
      );
    DELETE FROM hub_app.subscriptions
      WHERE user_id IN (
        SELECT supabase_user_id::uuid FROM hub_app.users
          WHERE email IN (${inList}) AND supabase_user_id IS NOT NULL
      );
    DELETE FROM hub_app.accounts
      WHERE user_id IN (SELECT id FROM hub_app.users WHERE email IN (${inList}));
    DELETE FROM hub_app.sessions
      WHERE user_id IN (SELECT id FROM hub_app.users WHERE email IN (${inList}));
    DELETE FROM hub_app.users WHERE email IN (${inList});
  `;
  try {
    runSqlOnStaging(sql);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cleanupLegacyEmails] best-effort cleanup failed', err);
  }
}

// ════════════════════════════════════════════════════════════════════════
// CAS 1 — User legacy SANS workspace (pré-backfill workspaces v1.4)
// ════════════════════════════════════════════════════════════════════════

test.describe('Cas 1 — User legacy sans workspace (pré-backfill v1.4)', () => {
  const seedEmails: string[] = [];

  test.afterAll(() => {
    cleanupLegacyEmails(seedEmails);
  });

  test('/dashboard/workspace/members render placeholder ou self-heal SANS crash', async ({
    request,
    playwright,
  }) => {
    const email = legacyEmail('no-ws');
    seedEmails.push(email);

    // Setup : user créé proprement via mock OAuth (createUser event provisionne
    // workspace), puis on supprime le workspace pour simuler un user pré-backfill.
    const loginCtx = await mockOauthLogin(playwright, email);

    // Force DELETE workspace + workspace_members associés à ce user.
    const userId = runSqlSelectFirst(
      `SELECT id FROM hub_app.users WHERE email = '${email}'`,
    );
    expect(userId).not.toBe('');

    runSqlOnStaging(`
      DELETE FROM hub_app.workspace_members WHERE user_id = '${userId}';
      DELETE FROM hub_app.workspaces WHERE owner_id = '${userId}';
    `);

    // Sanity check : pas de workspace
    const wsCount = runSqlSelectFirst(
      `SELECT COUNT(*) FROM hub_app.workspace_members WHERE user_id = '${userId}'`,
    );
    expect(wsCount).toBe('0');

    // Test 1 : GET /dashboard/workspace/members ne doit PAS crash 500.
    // Le code a un self-heal qui re-provisionne (cf. page.tsx:32-53).
    const membersRes = await loginCtx.get('/dashboard/workspace/members', {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(
      [200, 302, 307],
      `/dashboard/workspace/members status (got ${membersRes.status()})`,
    ).toContain(membersRes.status());
    expect(
      membersRes.status(),
      'self-heal ou placeholder, jamais 500',
    ).not.toBe(500);

    // Si 200 (= self-heal a réussi), un nouveau workspace doit exister.
    if (membersRes.status() === 200) {
      const wsAfter = runSqlSelectFirst(
        `SELECT COUNT(*) FROM hub_app.workspace_members WHERE user_id = '${userId}'`,
      );
      expect(
        Number(wsAfter),
        'self-heal devrait avoir re-provisionné un workspace',
      ).toBeGreaterThanOrEqual(1);
    }

    await loginCtx.dispose();
  });

  test('GET /dashboard sur user sans workspace → pas de crash 500', async ({
    request,
    playwright,
  }) => {
    const email = legacyEmail('no-ws-dash');
    seedEmails.push(email);

    const loginCtx = await mockOauthLogin(playwright, email);
    const userId = runSqlSelectFirst(
      `SELECT id FROM hub_app.users WHERE email = '${email}'`,
    );
    runSqlOnStaging(`
      DELETE FROM hub_app.workspace_members WHERE user_id = '${userId}';
      DELETE FROM hub_app.workspaces WHERE owner_id = '${userId}';
    `);

    const dashRes = await loginCtx.get('/dashboard', {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    // Le dashboard layout a sa requête workspace dans try/catch → ne crash pas.
    // 200 (render) ou 307 (redirect) acceptable, jamais 500.
    expect(
      dashRes.status(),
      `/dashboard sur legacy user (got ${dashRes.status()})`,
    ).not.toBe(500);
    expect([200, 302, 307]).toContain(dashRes.status());

    await loginCtx.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════════
// CAS 2 — User legacy SANS supabaseUserId (pré-backfill UUID bridge)
// ════════════════════════════════════════════════════════════════════════

test.describe('Cas 2 — User legacy sans supabaseUserId (pré-backfill UUID)', () => {
  const seedEmails: string[] = [];

  test.afterAll(() => {
    cleanupLegacyEmails(seedEmails);
  });

  test('GET /dashboard sur user supabaseUserId=NULL → crash explicite 500 (invariant)', async ({
    playwright,
  }) => {
    const email = legacyEmail('no-uuid-dash');
    seedEmails.push(email);

    const loginCtx = await mockOauthLogin(playwright, email);
    const userId = runSqlSelectFirst(
      `SELECT id FROM hub_app.users WHERE email = '${email}'`,
    );
    // Force supabase_user_id=NULL pour simuler état pré-backfill UUID.
    runSqlOnStaging(
      `UPDATE hub_app.users SET supabase_user_id = NULL WHERE id = '${userId}'`,
    );

    // GET /dashboard → app/dashboard/page.tsx ligne 32 fait `userUuid(user)`
    // HORS try/catch → crash 500 attendu. C'est l'invariant gravé par
    // le commit d25f575 (event createUser doit poser supabaseUserId).
    const dashRes = await loginCtx.get('/dashboard', {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(
      dashRes.status(),
      '/dashboard sur user sans supabaseUserId DOIT crash 500 (invariant code)',
    ).toBe(500);

    await loginCtx.dispose();
  });

  test('POST /api/invitations/[token]/accept sur user sans supabaseUserId → 409 user_not_provisioned', async ({
    request,
    playwright,
  }) => {
    // Setup : un inviter propre + un invitee qu'on va corrompre.
    const inviterEmail = legacyEmail('no-uuid-inviter');
    const inviteeEmail = legacyEmail('no-uuid-invitee');
    seedEmails.push(inviterEmail, inviteeEmail);

    const inviter = await adminCreateUser(
      request,
      inviterEmail,
      'No UUID Inviter',
    );

    // Créer l'invitee via mock OAuth d'abord (qui pose supabaseUserId via event),
    // puis le corrompre.
    const inviteeCtx = await mockOauthLogin(playwright, inviteeEmail);
    const inviteeId = runSqlSelectFirst(
      `SELECT id FROM hub_app.users WHERE email = '${inviteeEmail}'`,
    );
    runSqlOnStaging(
      `UPDATE hub_app.users SET supabase_user_id = NULL WHERE id = '${inviteeId}'`,
    );

    // Créer l'invitation via HMAC.
    const ts = Date.now();
    const body = JSON.stringify({
      inviter_user_id: inviter.user_id,
      inviter_email: inviterEmail,
      invitee_email: inviteeEmail,
      target_app: 'notifuse',
      target_workspace_id: `ws-legacy-${RUN_STAMP}`,
      target_role: 'member',
    });
    const sig = createHmac('sha256', SECRET_NOTIFUSE_INVITATION)
      .update(`${ts}.${body}`)
      .digest('hex');

    const createRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/invitations/create`, {
        headers: {
          'content-type': 'application/json',
          'x-veridian-app': 'notifuse',
          'x-veridian-timestamp': String(ts),
          'x-veridian-invitation-signature': sig,
          ...freshIpHeader(),
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(createRes.status()).toBe(201);
    const { token } = (await createRes.json()) as { token: string };

    // Accept depuis le user corrompu → DOIT renvoyer 409 user_not_provisioned
    // (anti-régression hotfix 5c9c68e). Si le code ne renvoie pas 409,
    // c'est qu'il a tenté l'attach downstream avec un id non-UUID → crash 500.
    const acceptRes = await withRateLimitRetry(() =>
      inviteeCtx.post(`/api/invitations/${token}/accept`, {
        headers: { 'content-type': 'application/json' },
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect(
      acceptRes.status(),
      'accept sur user sans supabaseUserId DOIT renvoyer 409 user_not_provisioned',
    ).toBe(409);
    const acceptBody = await acceptRes.json();
    expect(acceptBody.error).toBe('user_not_provisioned');

    await inviteeCtx.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════════
// CAS 3 — Tenant Notifuse avec metadata.notifuse_processed_events legacy
// ════════════════════════════════════════════════════════════════════════

test.describe('Cas 3 — Webhook Notifuse legacy HMAC (metadata.notifuse_processed_events)', () => {
  const seedEmails: string[] = [];
  let tenantId: string | null = null;
  const tenantSlug = `legacy-notif-${RUN_STAMP}`;

  test.afterAll(() => {
    if (tenantId) {
      try {
        runSqlOnStaging(`DELETE FROM hub_app.tenants WHERE id = '${tenantId}'`);
      } catch {
        /* ignore */
      }
    }
    cleanupLegacyEmails(seedEmails);
  });

  test.beforeAll(async ({ request }) => {
    // Setup : créer user + injecter directement un tenant avec
    // metadata.notifuse_processed_events pré-rempli.
    const email = legacyEmail('legacy-notif-owner');
    seedEmails.push(email);
    const u = await adminCreateUser(request, email, 'Legacy Notif Owner');

    // INSERT tenant avec metadata.notifuse_processed_events array de 199
    // events legacy (pour tester FIFO 200 max après ajout d'1 nouveau).
    const fakeEvents = Array.from(
      { length: 199 },
      (_, i) => `evt_legacy_${RUN_STAMP}_${i}`,
    );
    const metadata = JSON.stringify({
      notifuse_processed_events: fakeEvents,
    }).replace(/'/g, "''");

    tenantId = runSqlSelectFirst(`
      INSERT INTO hub_app.tenants (id, user_id, name, slug, status, notifuse_workspace_slug, metadata, created_at, updated_at)
      VALUES (gen_random_uuid(), '${u.supabase_user_id}', 'Legacy Notif Tenant', '${tenantSlug}-internal', 'active', '${tenantSlug}', '${metadata}'::jsonb, NOW(), NOW())
      RETURNING id
    `);
    expect(tenantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('replay event déjà dans notifuse_processed_events → 200 deduplicated', async ({
    request,
  }) => {
    const replayedEventId = `evt_legacy_${RUN_STAMP}_42`; // déjà dans le seed

    const ts = Date.now();
    const body = JSON.stringify({
      event_id: replayedEventId,
      event_type: 'email.sent',
      tenant_id: tenantSlug,
      data: { message_id: 'msg_replay', recipient: 'replay@example.com' },
    });
    const sig = createHmac('sha256', NOTIFUSE_HUB_WEBHOOK_SECRET)
      .update(`${ts}.${body}`)
      .digest('hex');

    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
        headers: {
          'content-type': 'application/json',
          'x-veridian-timestamp': String(ts),
          'x-veridian-notifuse-signature': sig,
          ...freshIpHeader(),
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.deduplicated).toBe(true);
  });

  test('nouvel event legacy → processé + ajouté à la liste, taille ≤ 200 (FIFO)', async ({
    request,
  }) => {
    const newEventId = `evt_legacy_NEW_${RUN_STAMP}_${randomUUID().slice(0, 8)}`;

    const ts = Date.now();
    const body = JSON.stringify({
      event_id: newEventId,
      event_type: 'tenant.suspended',
      tenant_id: tenantSlug,
      data: { suspended_at: new Date().toISOString(), reason: 'e2e-test' },
    });
    const sig = createHmac('sha256', NOTIFUSE_HUB_WEBHOOK_SECRET)
      .update(`${ts}.${body}`)
      .digest('hex');

    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
        headers: {
          'content-type': 'application/json',
          'x-veridian-timestamp': String(ts),
          'x-veridian-notifuse-signature': sig,
          ...freshIpHeader(),
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.deduplicated).toBeUndefined();

    // Vérifier que l'event est dans la liste + taille ≤ 200.
    const eventsRow = runSqlSelectFirst(
      `SELECT jsonb_array_length(metadata->'notifuse_processed_events') FROM hub_app.tenants WHERE id = '${tenantId}'`,
    );
    const size = Number(eventsRow);
    expect(size, 'taille de notifuse_processed_events').toBeGreaterThan(0);
    expect(size, 'FIFO 200 max').toBeLessThanOrEqual(200);

    // L'event doit être présent dans la liste.
    const containsEvent = runSqlSelectFirst(
      `SELECT (metadata->'notifuse_processed_events') ? '${newEventId}' FROM hub_app.tenants WHERE id = '${tenantId}'`,
    );
    expect(containsEvent).toBe('t');
  });

  test('coexistence path v1.4 Bearer + legacy HMAC sur même tenant', async ({
    request,
  }) => {
    // Path v1.4 (Bearer) sur même tenant — DOIT être traité indépendamment
    // de la dédup legacy (utilise webhook_dedup table, pas metadata).
    const idemKey = randomUUID();
    const v14Body = {
      event: 'tenant.touched',
      tenant_id: tenantSlug,
      idempotency_key: idemKey,
      occurred_at: new Date().toISOString(),
      contract_version: '1.4',
      data: {},
    };

    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${NOTIFUSE_WEBHOOK_TOKEN}`,
          ...freshIpHeader(),
        },
        data: v14Body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);

    // Le path v1.4 ne touche PAS metadata.notifuse_processed_events
    // (uniquement webhook_dedup). Vérifier que la dédup legacy n'a pas
    // été polluée par l'idempotency_key v1.4.
    const containsIdem = runSqlSelectFirst(
      `SELECT (metadata->'notifuse_processed_events') ? '${idemKey}' FROM hub_app.tenants WHERE id = '${tenantId}'`,
    );
    expect(
      containsIdem,
      'webhook v1.4 ne doit PAS polluer la liste legacy',
    ).toBe('f');
  });
});

// ════════════════════════════════════════════════════════════════════════
// CAS 4 — Subscription legacy avec stripe_customer_id mais users.stripe_customer_id=NULL
// ════════════════════════════════════════════════════════════════════════

test.describe('Cas 4 — Subscription legacy sans users.stripe_customer_id', () => {
  const seedEmails: string[] = [];

  test.afterAll(() => {
    cleanupLegacyEmails(seedEmails);
  });

  test('GET /dashboard/billing affiche bien la subscription legacy', async ({
    playwright,
  }) => {
    const email = legacyEmail('sub-legacy');
    seedEmails.push(email);

    const loginCtx = await mockOauthLogin(playwright, email);
    const userId = runSqlSelectFirst(
      `SELECT id FROM hub_app.users WHERE email = '${email}'`,
    );
    const supabaseUuid = runSqlSelectFirst(
      `SELECT supabase_user_id FROM hub_app.users WHERE id = '${userId}'`,
    );
    expect(supabaseUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Setup : Subscription legacy avec stripe_customer_id défini MAIS
    // users.stripe_customer_id=NULL (état pré-sprint v1.4).
    const fakeCustomerId = `cus_legacy_${RUN_STAMP.slice(0, 8)}_${randomUUID().slice(0, 8)}`;
    runSqlOnStaging(`
      INSERT INTO hub_app.subscriptions (id, user_id, stripe_customer_id, status, created_at, updated_at)
      VALUES (gen_random_uuid(), '${supabaseUuid}'::uuid, '${fakeCustomerId}', 'active', NOW(), NOW());
      UPDATE hub_app.users SET stripe_customer_id = NULL WHERE id = '${userId}';
    `);

    // GET /dashboard/billing → doit afficher la sub.
    const billingRes = await loginCtx.get('/dashboard/billing', {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(billingRes.status()).toBe(200);
    const html = await billingRes.text();
    // La page rend le composant SubscriptionCard quand une sub existe (titre
    // "Mon abonnement" + description "Le détail de ta formule Veridian.").
    // Quand aucune sub n'est trouvée, EmptyBillingState affiche "Aucun
    // abonnement actif" + CTA "Découvrir les formules". Les strings sont en
    // français (cf. app/dashboard/billing/page.tsx + EmptyBillingState.tsx).
    expect(
      html,
      '/dashboard/billing doit afficher la sub legacy (titre Mon abonnement)',
    ).toContain('Mon abonnement');
    expect(
      html,
      '/dashboard/billing doit rendre le composant SubscriptionCard (description plan)',
    ).toContain('formule Veridian');
    expect(
      html.includes('Aucun abonnement actif'),
      'sub legacy doit être visible (pas "Aucun abonnement actif" qui est l\'EmptyBillingState)',
    ).toBe(false);

    await loginCtx.dispose();
  });

  test('POST /api/billing/checkout réutilise stripe_customer_id depuis Subscription legacy', async ({
    playwright,
  }) => {
    const email = legacyEmail('sub-reuse');
    seedEmails.push(email);

    const loginCtx = await mockOauthLogin(playwright, email);
    const userId = runSqlSelectFirst(
      `SELECT id FROM hub_app.users WHERE email = '${email}'`,
    );
    const supabaseUuid = runSqlSelectFirst(
      `SELECT supabase_user_id FROM hub_app.users WHERE id = '${userId}'`,
    );

    // Setup : Subscription legacy + users.stripe_customer_id=NULL
    const fakeCustomerId = `cus_legacy_reuse_${RUN_STAMP.slice(0, 8)}`;
    runSqlOnStaging(`
      INSERT INTO hub_app.subscriptions (id, user_id, stripe_customer_id, status, created_at, updated_at)
      VALUES (gen_random_uuid(), '${supabaseUuid}'::uuid, '${fakeCustomerId}', 'canceled', NOW(), NOW());
      UPDATE hub_app.users SET stripe_customer_id = NULL WHERE id = '${userId}';
    `);

    // POST /api/billing/checkout — Stripe va échouer car cus_legacy_xxx n'existe
    // pas dans Stripe staging. Mais le code DOIT d'abord lire stripe_customer_id
    // depuis Subscription (cf. resolveStripeCustomerId line 25-31). On vérifie
    // ça en s'attendant à 502 "stripe_customer_failed" ou "stripe_session_failed",
    // PAS un 200 (qui voudrait dire qu'il a créé un NOUVEAU customer en silence
    // → bug : 2 customers pour 1 user, breaks billing).
    //
    // Note : plan key catalogué = `prospection-pro` (cf. lib/pricing/plans.ts).
    const checkoutRes = await withRateLimitRetry(() =>
      loginCtx.post('/api/billing/checkout', {
        headers: { 'content-type': 'application/json' },
        data: { plan: 'prospection-pro', interval: 'month' },
        failOnStatusCode: false,
      }),
    );
    // DURCI 2026-05-23 (ticket e2e-harden-tolerances) :
    // Stripe TEST staging entièrement configuré depuis 2026-05-23
    // (Prices catalogués + head_office FR), donc 503 stripe_price_not_configured
    // n'est plus un fallback acceptable. Acceptable ici :
    //   - 200 (reuse réussit côté Stripe — improbable car cus_legacy fictif
    //     mais on accepte au cas où Stripe TEST devient permissif)
    //   - 502 (Stripe refuse le cus_xxx inexistant → stripe_customer_failed
    //     ou stripe_session_failed — comportement attendu du code legacy reuse)
    // 400 = bug (plan inconnu ou invalid_json), 500 = bug Hub (pas de catch),
    // 503 = misconfig Stripe staging (cf. ticket e2e-harden-tolerances).
    expect(
      [200, 502],
      `checkout status (got ${checkoutRes.status()}) — révèle bug si 400/500/503`,
    ).toContain(checkoutRes.status());

    if (checkoutRes.status() === 200) {
      const body = await checkoutRes.json();
      // eslint-disable-next-line no-console
      console.log('[Cas 4] checkout 200 avec sub legacy:', body);
    }

    await loginCtx.dispose();
  });
});

// ════════════════════════════════════════════════════════════════════════
// CAS 5 — Invitation cross-app expirée + tenant soft-deleted
// ════════════════════════════════════════════════════════════════════════

test.describe('Cas 5 — Invitation expirée + tenant soft-deleted (cleanup paths)', () => {
  const seedEmails: string[] = [];
  let softDeletedTenantId: string | null = null;
  const softDeletedTenantSlug = `legacy-soft-${RUN_STAMP}`;

  test.afterAll(() => {
    if (softDeletedTenantId) {
      try {
        runSqlOnStaging(
          `DELETE FROM hub_app.tenants WHERE id = '${softDeletedTenantId}'`,
        );
      } catch {
        /* ignore */
      }
    }
    cleanupLegacyEmails(seedEmails);
  });

  test('GET /api/invitations/[token]/verify sur invitation expirée → 200 reason=expired', async ({
    request,
  }) => {
    const inviterEmail = legacyEmail('exp-inviter');
    seedEmails.push(inviterEmail);
    const inviter = await adminCreateUser(
      request,
      inviterEmail,
      'Exp Inviter',
    );

    // INSERT direct d'une invitation déjà expirée (expires_at dans le passé).
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const invitationId = `inv_${RUN_STAMP}_${randomUUID().slice(0, 8)}`;
    runSqlOnStaging(`
      INSERT INTO hub_app.cross_app_invitations
        (id, token, inviter_user_id, inviter_email, invitee_email, target_app, target_workspace_id, target_role, expires_at, created_at)
      VALUES
        ('${invitationId}', '${token}', '${inviter.user_id}', '${inviterEmail}', '${legacyEmail('exp-invitee')}', 'notifuse', 'ws-exp-${RUN_STAMP}', 'member', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours')
    `);

    // /verify retourne 200 avec body.reason='expired' (cf. verify/route.ts:95).
    // C'est conforme au contrat actuel : le code distingue 4 reasons en body
    // mais retourne 200 pour ne pas trahir l'existence du token.
    const verifyRes = await withRateLimitRetry(() =>
      request.get(`${STAGING_URL}/api/invitations/${token}/verify`, {
        failOnStatusCode: false,
      }),
    );
    expect(verifyRes.status()).toBe(200);
    const body = await verifyRes.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('expired');
  });

  test('POST /api/invitations/[token]/accept sur invitation expirée → 410 Gone', async ({
    request,
    playwright,
  }) => {
    const inviterEmail = legacyEmail('exp2-inviter');
    const inviteeEmail = legacyEmail('exp2-invitee');
    seedEmails.push(inviterEmail, inviteeEmail);

    const inviter = await adminCreateUser(
      request,
      inviterEmail,
      'Exp2 Inviter',
    );
    const inviteeCtx = await mockOauthLogin(playwright, inviteeEmail);

    const token =
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const invitationId = `inv_${RUN_STAMP}_${randomUUID().slice(0, 8)}`;
    runSqlOnStaging(`
      INSERT INTO hub_app.cross_app_invitations
        (id, token, inviter_user_id, inviter_email, invitee_email, target_app, target_workspace_id, target_role, expires_at, created_at)
      VALUES
        ('${invitationId}', '${token}', '${inviter.user_id}', '${inviterEmail}', '${inviteeEmail}', 'notifuse', 'ws-exp2-${RUN_STAMP}', 'member', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours')
    `);

    const acceptRes = await withRateLimitRetry(() =>
      inviteeCtx.post(`/api/invitations/${token}/accept`, {
        headers: { 'content-type': 'application/json' },
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect(acceptRes.status(), 'expired invitation accept → 410 Gone').toBe(
      410,
    );
    const body = await acceptRes.json();
    expect(body.error).toBe('expired');

    await inviteeCtx.dispose();
  });

  test('Webhook tenant.touched (v1.4) sur tenant soft-deleted → 200 stub (no revive en l\'état)', async ({
    request,
  }) => {
    // Setup : créer un tenant + soft-delete.
    const ownerEmail = legacyEmail('soft-owner');
    seedEmails.push(ownerEmail);
    const u = await adminCreateUser(request, ownerEmail, 'Soft Owner');

    softDeletedTenantId = runSqlSelectFirst(`
      INSERT INTO hub_app.tenants (id, user_id, name, slug, status, notifuse_workspace_slug, deleted_at, created_at, updated_at)
      VALUES (gen_random_uuid(), '${u.supabase_user_id}', 'Soft Deleted Tenant', '${softDeletedTenantSlug}-int', 'active', '${softDeletedTenantSlug}', NOW() - INTERVAL '1 day', NOW(), NOW())
      RETURNING id
    `);
    expect(softDeletedTenantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Sanity : deleted_at est bien posé.
    const deletedAt = runSqlSelectFirst(
      `SELECT deleted_at FROM hub_app.tenants WHERE id = '${softDeletedTenantId}'`,
    );
    expect(deletedAt).not.toBe('');

    // Webhook tenant.touched v1.4 → handler stub actuel (cf.
    // notifuse-handlers.ts:22-31) ne fait que console.info, ne touche pas
    // à deleted_at. Le webhook DOIT retourner 200 (event accepté + persisté
    // dans webhook_dedup) sans crash.
    const idemKey = randomUUID();
    const v14Body = {
      event: 'tenant.touched',
      tenant_id: softDeletedTenantSlug,
      idempotency_key: idemKey,
      occurred_at: new Date().toISOString(),
      contract_version: '1.4',
      data: { ts: Date.now() },
    };

    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/webhooks/notifuse`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${NOTIFUSE_WEBHOOK_TOKEN}`,
          ...freshIpHeader(),
        },
        data: v14Body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(200);

    // Vérifier que deleted_at n'a PAS été reset (handler stub à ce jour).
    // Si jamais un futur ticket implémente le revive, ce test failera et
    // il faudra l'adapter — c'est volontaire.
    const deletedAtAfter = runSqlSelectFirst(
      `SELECT deleted_at FROM hub_app.tenants WHERE id = '${softDeletedTenantId}'`,
    );
    expect(
      deletedAtAfter,
      'tenant.touched stub actuel ne reset PAS deleted_at',
    ).toBe(deletedAt);
  });

  test('Trial state machine ignore les tenants soft-deleted — phase activate', async ({
    request,
  }) => {
    // Setup : créer un tenant soft-deleted + une row tenant_trials state=eligible
    // datant de > 48h. Le cron tick NE DOIT PAS activer le trial.
    //
    // INVARIANT (fix commit 2a1a12e) : lib/trial/run-tick.ts filtre les 3
    // phases via EXISTS (SELECT 1 FROM hub_app.tenants t WHERE
    // (t.id::text=tenant_id OR t.notifuse_workspace_slug=tenant_id OR
    // t.slug=tenant_id) AND t.deleted_at IS NULL). Donc un trial sur tenant
    // soft-deleted DOIT rester state=eligible (pas trial_active).

    const ownerEmail = legacyEmail('trial-soft');
    seedEmails.push(ownerEmail);
    const u = await adminCreateUser(request, ownerEmail, 'Trial Soft Owner');

    const trialTenantSlug = `legacy-trial-soft-${RUN_STAMP}`;
    const trialTenantId = runSqlSelectFirst(`
      INSERT INTO hub_app.tenants (id, user_id, name, slug, status, notifuse_workspace_slug, deleted_at, created_at, updated_at)
      VALUES (gen_random_uuid(), '${u.supabase_user_id}', 'Trial Soft Tenant', '${trialTenantSlug}-int', 'active', '${trialTenantSlug}', NOW() - INTERVAL '1 day', NOW(), NOW())
      RETURNING id
    `);

    // INSERT tenant_trials eligible depuis 49h (>48h cutoff = devrait s'activer
    // SAUF si le filtre soft-delete fait son job).
    runSqlOnStaging(`
      INSERT INTO hub_app.tenant_trials (tenant_id, app, state, eligible_at, created_at, updated_at)
      VALUES ('${trialTenantSlug}', 'notifuse', 'eligible', NOW() - INTERVAL '49 hours', NOW() - INTERVAL '49 hours', NOW() - INTERVAL '49 hours')
    `);

    // Trigger cron tick manuellement (auth Bearer CRON_SECRET).
    const cronSecret = process.env.CRON_SECRET || 'staging-cron-secret';
    const tickRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/cron/trial-tick`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cronSecret}`,
        },
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect(tickRes.status()).toBe(200);

    // Lire l'état du trial après tick.
    const stateAfter = runSqlSelectFirst(
      `SELECT state FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}' AND app = 'notifuse'`,
    );

    // Assertion STRICTE post-fix : le trial NE DOIT PAS s'activer sur tenant
    // soft-deleted. Si on observe `trial_active` → le fix code n'a pas marché
    // en runtime, escalader immédiatement.
    expect(
      stateAfter,
      'fix commit 2a1a12e : le cron NE DOIT PAS activer un trial sur tenant soft-deleted',
    ).toBe('eligible');

    // trial_started_at / trial_ends_at doivent rester NULL.
    const startedAt = runSqlSelectFirst(
      `SELECT trial_started_at FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}' AND app = 'notifuse'`,
    );
    expect(
      startedAt,
      'trial_started_at doit rester NULL (cron ignore)',
    ).toBe('');

    // Cleanup spécifique — IMPORTANT : DELETE trials AVANT tenants (FK)
    // et on fait CHAQUE statement séparé pour éviter les agrégations stdout
    // qui ont déjà pété la suite la 1ère fois.
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}'`,
      );
    } catch {
      /* ignore */
    }
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE id = '${trialTenantId}'`,
      );
    } catch {
      /* ignore */
    }
  });

  test('Trial state machine ignore les tenants soft-deleted — phase notify-ending-soon', async ({
    request,
  }) => {
    // Setup : tenant ACTIF avec un trial déjà actif depuis 13j (donc dans la
    // fenêtre J+12 du notify), puis on soft-delete le tenant. Le cron tick
    // NE DOIT PAS notifier (ne doit pas flag ending_soon_notified=true).
    //
    // INVARIANT (fix commit 2a1a12e) : processEndingSoon a le même EXISTS
    // sur tenants.deleted_at IS NULL.

    const ownerEmail = legacyEmail('trial-soft-notify');
    seedEmails.push(ownerEmail);
    const u = await adminCreateUser(request, ownerEmail, 'Trial Soft Notify Owner');

    const trialTenantSlug = `legacy-trial-soft-notify-${RUN_STAMP}`;

    // Crée le tenant ACTIF d'abord (deleted_at NULL pour passer le 1er filtre
    // si on voulait tester l'activate, mais ici on bypass activate en injectant
    // state=trial_active direct). Puis on soft-delete pour simuler "trial en
    // cours, owner soft-delete son tenant".
    const trialTenantId = runSqlSelectFirst(`
      INSERT INTO hub_app.tenants (id, user_id, name, slug, status, notifuse_workspace_slug, deleted_at, created_at, updated_at)
      VALUES (gen_random_uuid(), '${u.supabase_user_id}', 'Trial Soft Notify Tenant', '${trialTenantSlug}-int', 'active', '${trialTenantSlug}', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '13 days', NOW())
      RETURNING id
    `);

    // INSERT trial actif depuis 13j (> seuil J+12 du notify, < J+15 du finalize),
    // ending_soon_notified=FALSE → devrait être notifié SI le filtre soft-delete
    // ne fait pas son job.
    runSqlOnStaging(`
      INSERT INTO hub_app.tenant_trials (tenant_id, app, state, eligible_at, trial_started_at, trial_ends_at, ending_soon_notified, created_at, updated_at)
      VALUES ('${trialTenantSlug}', 'notifuse', 'trial_active', NOW() - INTERVAL '15 days', NOW() - INTERVAL '13 days', NOW() + INTERVAL '2 days', FALSE, NOW() - INTERVAL '15 days', NOW())
    `);

    const cronSecret = process.env.CRON_SECRET || 'staging-cron-secret';
    const tickRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/cron/trial-tick`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cronSecret}`,
        },
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect(tickRes.status()).toBe(200);

    // ending_soon_notified DOIT rester FALSE — le tenant est soft-deleted,
    // le cron doit le skip.
    const notified = runSqlSelectFirst(
      `SELECT ending_soon_notified FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}' AND app = 'notifuse'`,
    );
    expect(
      notified,
      'fix commit 2a1a12e : pas de mail ending-soon sur tenant soft-deleted (psql -tA renvoie t/f)',
    ).toBe('f');

    // L'état du trial doit aussi rester trial_active (pas converti, pas expiré,
    // pas re-activé).
    const stateAfter = runSqlSelectFirst(
      `SELECT state FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}' AND app = 'notifuse'`,
    );
    expect(stateAfter).toBe('trial_active');

    // Cleanup
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}'`,
      );
    } catch {
      /* ignore */
    }
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE id = '${trialTenantId}'`,
      );
    } catch {
      /* ignore */
    }
  });

  test('Trial state machine ignore les tenants soft-deleted — phase finalize (pas de downgrade update-plan)', async ({
    request,
  }) => {
    // Setup : trial actif dont trial_ends_at est passé (J+15 atteint), puis
    // soft-delete le tenant. Le cron tick NE DOIT PAS :
    //   - passer le state à 'expired' ou 'converted'
    //   - appeler notifuseClient.updatePlan(plan='free') (downgrade silencieux
    //     sur tenant déjà nettoyé = bruit côté Notifuse + 404 silencieux)
    //
    // INVARIANT (fix commit 2a1a12e) : processFinalize a le même EXISTS
    // sur tenants.deleted_at IS NULL.

    const ownerEmail = legacyEmail('trial-soft-finalize');
    seedEmails.push(ownerEmail);
    const u = await adminCreateUser(request, ownerEmail, 'Trial Soft Finalize Owner');

    const trialTenantSlug = `legacy-trial-soft-finalize-${RUN_STAMP}`;

    // Tenant soft-deleted (le owner a supprimé son workspace pendant le trial).
    const trialTenantId = runSqlSelectFirst(`
      INSERT INTO hub_app.tenants (id, user_id, name, slug, status, notifuse_workspace_slug, deleted_at, created_at, updated_at)
      VALUES (gen_random_uuid(), '${u.supabase_user_id}', 'Trial Soft Finalize Tenant', '${trialTenantSlug}-int', 'active', '${trialTenantSlug}', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '16 days', NOW())
      RETURNING id
    `);

    // INSERT trial actif depuis 16j avec trial_ends_at -1d (cible de la
    // phase finalize). ending_soon_notified=TRUE pour ne pas leak via la
    // phase notify (qu'on a déjà testée juste avant).
    runSqlOnStaging(`
      INSERT INTO hub_app.tenant_trials (tenant_id, app, state, eligible_at, trial_started_at, trial_ends_at, ending_soon_notified, created_at, updated_at)
      VALUES ('${trialTenantSlug}', 'notifuse', 'trial_active', NOW() - INTERVAL '18 days', NOW() - INTERVAL '16 days', NOW() - INTERVAL '1 day', TRUE, NOW() - INTERVAL '18 days', NOW())
    `);

    const cronSecret = process.env.CRON_SECRET || 'staging-cron-secret';
    const tickRes = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/cron/trial-tick`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cronSecret}`,
        },
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect(tickRes.status()).toBe(200);

    // Le state DOIT rester trial_active : le cron a skip le tenant soft-deleted.
    // (Pas converti, pas expiré, pas downgradé via update-plan.)
    const stateAfter = runSqlSelectFirst(
      `SELECT state FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}' AND app = 'notifuse'`,
    );
    expect(
      stateAfter,
      'fix commit 2a1a12e : finalize doit ignorer un tenant soft-deleted (pas downgrade update-plan)',
    ).toBe('trial_active');

    // expired_at doit rester NULL.
    const expiredAt = runSqlSelectFirst(
      `SELECT expired_at FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}' AND app = 'notifuse'`,
    );
    expect(
      expiredAt,
      'expired_at doit rester NULL (pas de finalize sur tenant mort)',
    ).toBe('');

    // Cleanup
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenant_trials WHERE tenant_id = '${trialTenantSlug}'`,
      );
    } catch {
      /* ignore */
    }
    try {
      runSqlOnStaging(
        `DELETE FROM hub_app.tenants WHERE id = '${trialTenantId}'`,
      );
    } catch {
      /* ignore */
    }
  });
});
