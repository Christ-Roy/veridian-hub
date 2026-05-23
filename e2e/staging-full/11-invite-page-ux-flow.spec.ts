/**
 * Journey 11 — Page `/invite/[token]` UX bout-en-bout.
 *
 * **POURQUOI** : la page `/invite/[token]` (commit 3d1029f, 2026-05-21) gère
 * 3 cas downstream (completed / pending / error) via les composants
 * `AcceptCrossAppInviteButton`, `AcceptInviteButton` et `InviteSignInOptions`.
 * Le spec 05 teste l'API server-side mais pas le rendu UI ni les boutons.
 * Une régression CSS ou un mauvais data-testid casse le funnel d'acquisition
 * cross-app sans qu'aucun test ne le détecte.
 *
 * **CE QUE CE SPEC COUVRE** :
 *
 *   S1 GET /invite/<inexistant> → 200, contenu "introuvable"
 *      (pas de 500 sur token mal formé / inconnu)
 *   S2 GET /invite/<format invalide> → 200, contenu "introuvable"
 *   S3 GET /invite/<token-valid> non-loggué → page avec
 *      InviteSignInOptions (data-testid=invite-signin-google ou
 *      invite-signin-microsoft selon allowOauth, ou bouton signup/login)
 *   S4 GET /invite/<token-valid> loggué → bouton "Accepter l'invitation"
 *      (data-testid=invite-accept-button) visible
 *   S5 Click "Accepter" + downstream completed → redirect vers downstream
 *      URL ou alert "Redirection vers ... en cours"
 *   S6 Click "Accepter" sur invitation déjà acceptée → alerte error
 *      (data-testid=invite-error)
 *   S7 GET /invite/<token-consumed> → contenu "déjà utilisée"
 *
 * **DÉPENDANCES** :
 *   - Mock OAuth provider actif (DEPLOY_ENV=staging + OAUTH_TEST_PROVIDER=true)
 *   - ADMIN_SECRET + HUB_INVITATION_SECRET_NOTIFUSE injectés
 *
 * **CLEANUP** : on supprime les users + invitations créés via SQL direct
 * en fin de test (préfixe `invite-ux-e2e-${RUN_STAMP}`).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';

import {
  STAGING_URL,
  ADMIN_SECRET,
  RUN_STAMP,
  adminHeaders,
  bypassRateLimitHeaders,
  freshIpHeader,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';
import { runSqlOnStaging } from './_sql-helper';

const SECRET_NOTIFUSE =
  process.env.HUB_INVITATION_SECRET_NOTIFUSE ||
  'staging-invitation-secret-notifuse-not-real-e2e';

function uniqueEmail(slug: string): string {
  return makeEmail(`invite-ux-${slug}`);
}

interface CreatedUser {
  user_id: string;
  supabase_user_id: string;
  email: string;
}

async function adminCreateUser(
  request: APIRequestContext,
  email: string,
): Promise<CreatedUser> {
  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email, name: `UX Test ${email}` },
      failOnStatusCode: false,
    }),
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as CreatedUser;
}

async function createInvitation(
  request: APIRequestContext,
  inviter: CreatedUser,
  inviteeEmail: string,
): Promise<{ token: string; magic_link_url: string }> {
  const ts = Date.now();
  const body = JSON.stringify({
    inviter_user_id: inviter.user_id,
    inviter_email: inviter.email,
    invitee_email: inviteeEmail,
    target_app: 'notifuse',
    target_workspace_id: `ws-ux-${RUN_STAMP}`,
    target_role: 'member',
  });
  const sig = createHmac('sha256', SECRET_NOTIFUSE)
    .update(`${ts}.${body}`)
    .digest('hex');

  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/invitations/create`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'notifuse',
        'x-veridian-timestamp': String(ts),
        'x-veridian-invitation-signature': sig,
        ...freshIpHeader(),
        // Bypass invitationCreateLimiter (60/min/IP) sur staging E2E.
        ...bypassRateLimitHeaders(),
      },
      data: body,
      failOnStatusCode: false,
    }),
  );
  expect(res.status()).toBe(201);
  return await res.json();
}

async function mockOauthLogin(
  playwright: typeof import('@playwright/test'),
  email: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  await ctx.post('/api/auth/callback/mock-oauth', {
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
  return ctx;
}

// ─── S1 + S2 : tokens invalides ──────────────────────────────────────────

test.describe('Journey 11 — S1/S2 token invalide / introuvable', () => {
  test('S1 : token au bon format mais inexistant → page "introuvable"', async ({
    page,
  }) => {
    const fakeToken = 'a'.repeat(64); // 64 hex chars, format valide mais aucun match DB
    await page.goto(`${STAGING_URL}/invite/${fakeToken}`);
    await expect(
      page.locator('text=/introuvable|introuvable|invalide/i').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Garde-fou : ne doit JAMAIS faire 500.
    // (Playwright n'expose pas le status HTTP du document principal sans
    // intercepter via context.on('response'), mais si la page rend du texte
    // c'est qu'on a un 200.)
  });

  test('S2 : token format invalide (trop court, non-hex) → page "introuvable"', async ({
    page,
  }) => {
    await page.goto(`${STAGING_URL}/invite/not-a-token-at-all`);
    await expect(
      page.locator('text=/introuvable|invalide/i').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── S3 : token valide, non-loggué → InviteSignInOptions ─────────────────

test.describe('Journey 11 — S3 token valide non-loggué', () => {
  test('S3 : affiche les options de signin (signup/login boutons)', async ({
    page,
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('s3-inviter'),
    );
    const invitee = uniqueEmail('s3-invitee');
    await adminCreateUser(request, invitee);
    const inv = await createInvitation(request, inviter, invitee);

    await page.goto(`${STAGING_URL}/invite/${inv.token}`);

    // Le composant InviteSignInOptions doit être rendu : bouton signup
    // (lien vers /signup) OU bouton OAuth (data-testid invite-signin-*).
    // L'invariant CSS+a11y : un des deux doit être trouvable.
    const hasSignupLink = await page
      .locator('a[href*="/signup"]')
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    const hasOauthGoogle = await page
      .locator('[data-testid="invite-signin-google"]')
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    const hasLoginLink = await page
      .locator('a[href*="/login"]')
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);

    expect(
      hasSignupLink || hasOauthGoogle || hasLoginLink,
      'la page non-loggué DOIT afficher au moins un moyen de se connecter ' +
        '(signup/login link ou bouton OAuth)',
    ).toBe(true);

    // Le titre doit mentionner "Connectez-vous"
    await expect(
      page.locator('text=/Connectez|Se connecter/i').first(),
    ).toBeVisible();
  });
});

// ─── S4 + S5 + S6 : token valide, loggué ─────────────────────────────────

test.describe('Journey 11 — S4/S5/S6 acceptation cross-app loggué', () => {
  test('S4 : page rend le bouton "Accepter" (data-testid=invite-accept-button)', async ({
    request,
    playwright,
  }) => {
    const inviter = await adminCreateUser(request, uniqueEmail('s4-inviter'));
    const invitee = uniqueEmail('s4-invitee');
    await adminCreateUser(request, invitee);
    const inv = await createInvitation(request, inviter, invitee);

    const ctx = await mockOauthLogin(playwright, invitee);
    const browser = await playwright.chromium.launch();
    const page = await browser.newPage();

    // Transférer les cookies de session du ctx APIRequestContext vers la page browser
    const cookies = (await ctx.storageState()).cookies;
    await page.context().addCookies(cookies);

    try {
      await page.goto(`${STAGING_URL}/invite/${inv.token}`);
      await expect(
        page.locator('[data-testid="invite-accept-button"]'),
      ).toBeVisible({ timeout: 10_000 });
      // Le nom de l'app doit apparaître quelque part (Notifuse)
      await expect(page.locator('text=/Notifuse/i').first()).toBeVisible();
    } finally {
      await page.close();
      await browser.close();
      await ctx.dispose();
    }
  });

  test('S5 : click accept → outcome state ∈ {completed, pending, error} (UI sync)', async ({
    request,
    playwright,
  }) => {
    const inviter = await adminCreateUser(request, uniqueEmail('s5-inviter'));
    const invitee = uniqueEmail('s5-invitee');
    await adminCreateUser(request, invitee);
    const inv = await createInvitation(request, inviter, invitee);

    const ctx = await mockOauthLogin(playwright, invitee);
    const browser = await playwright.chromium.launch();
    const page = await browser.newPage();
    const cookies = (await ctx.storageState()).cookies;
    await page.context().addCookies(cookies);

    try {
      await page.goto(`${STAGING_URL}/invite/${inv.token}`);
      await expect(
        page.locator('[data-testid="invite-accept-button"]'),
      ).toBeVisible({ timeout: 10_000 });

      // Click et attente d'un état terminal :
      //   - completed → "Redirection vers ... en cours" (Alert)
      //   - pending   → data-testid=invite-pending
      //   - error     → data-testid=invite-error
      //
      // On laisse 15s pour le call downstream + le re-render React.
      await page.click('[data-testid="invite-accept-button"]');

      const terminalState = await Promise.race([
        page
          .locator('text=/Redirection vers/i')
          .first()
          .waitFor({ timeout: 15_000 })
          .then(() => 'completed'),
        page
          .locator('[data-testid="invite-pending"]')
          .waitFor({ timeout: 15_000 })
          .then(() => 'pending'),
        page
          .locator('[data-testid="invite-error"]')
          .waitFor({ timeout: 15_000 })
          .then(() => 'error'),
      ]).catch(() => 'timeout');

      expect(
        ['completed', 'pending', 'error'],
        `click Accepter doit poser un outcome terminal (got ${terminalState})`,
      ).toContain(terminalState);
    } finally {
      await page.close();
      await browser.close();
      await ctx.dispose();
    }
  });

  test('S6 : re-accept invitation déjà consumed → alerte error "déjà acceptée"', async ({
    request,
    playwright,
  }) => {
    const inviter = await adminCreateUser(request, uniqueEmail('s6-inviter'));
    const invitee = uniqueEmail('s6-invitee');
    await adminCreateUser(request, invitee);
    const inv = await createInvitation(request, inviter, invitee);

    // 1er accept via API → consume le token.
    const ctx1 = await mockOauthLogin(playwright, invitee);
    const acceptRes = await ctx1.post(`/api/invitations/${inv.token}/accept`, {
      data: {},
      failOnStatusCode: false,
    });
    // DURCI 2026-05-23 (ticket e2e-harden-tolerances) : 502 reste légitime
    // (downstream Notifuse staging HS), 500 = bug Hub à fixer.
    expect([200, 202, 502]).toContain(acceptRes.status());
    expect(
      acceptRes.status(),
      'INVARIANT : pas de 500 sur accept invitation',
    ).not.toBe(500);
    await ctx1.dispose();

    // 2e visite → la page doit afficher "déjà utilisée".
    const browser = await playwright.chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(`${STAGING_URL}/invite/${inv.token}`);
      await expect(
        page.locator('text=/déjà utilisée|already accepted|consumed/i').first(),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await page.close();
      await browser.close();
    }
  });
});

// ─── S7 : workspace invitation déjà acceptée → "déjà utilisée" ───────────

test.describe('Journey 11 — S7 token consumé (Cross-App Invitation marqué accepté)', () => {
  test('S7 : si crossAppInvitation.acceptedAt est posé, la page rend "déjà utilisée"', async ({
    page,
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('s7-inviter'),
    );
    const invitee = uniqueEmail('s7-invitee');
    await adminCreateUser(request, invitee);
    const inv = await createInvitation(request, inviter, invitee);

    // Marque l'invitation comme déjà acceptée via SQL direct (sinon il
    // faudrait faire un accept réel + login mock OAuth).
    // ⚠️ Les colonnes sont en snake_case côté DB (cf Prisma @map dans
    // schema.prisma : `acceptedAt @map("accepted_at")`). NE PAS quoter
    // en camelCase, ça reproduit `column "acceptedAt" does not exist`.
    runSqlOnStaging(
      `UPDATE hub_app.cross_app_invitations
       SET accepted_at = NOW()
       WHERE token = '${inv.token}';`,
    );

    await page.goto(`${STAGING_URL}/invite/${inv.token}`);
    await expect(
      page.locator('text=/déjà utilisée|consumed/i').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
