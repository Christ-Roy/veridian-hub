/**
 * Journey 11 — UI invite flow `/invite/[token]`.
 *
 * **POURQUOI** : le spec 05 couvre l'API HMAC + accept de bout en bout
 * mais ne valide PAS la page UI `/invite/[token]`. Or c'est la première
 * impression du user invité : si elle plante, le flow d'onboarding est
 * cassé pour 100% des invitations cross-app envoyées.
 *
 * **CE QUE CE SPEC COUVRE** :
 *   1. Token inconnu → page "Invitation introuvable" + lien /login
 *   2. Token au mauvais format (court, non-hex) → "introuvable"
 *   3. Invite valide + user non loggué → bloc sign-in visible
 *      (Google + Microsoft + signup email + login existant — OAuth
 *      gated DEPLOY_ENV != staging, donc en staging on vérifie au moins
 *      signup + login existant visibles)
 *   4. Invite valide + user loggué (mock OAuth) → bouton "Accepter"
 *      + click → réponse 200/202/502 → message UI exploitable
 *
 * **DÉPENDANCES** :
 *   - Spec 05 doit avoir validé `/api/invitations/create` (sinon pas de
 *     token valide à exploiter ici).
 *   - `OAUTH_TEST_PROVIDER=true` pour le mock OAuth login.
 *   - `HUB_INVITATION_SECRET_PROSPECTION` injecté en staging.
 *
 * **NOTES MAINTENANCE** :
 *   - Si on rebrand le bouton ou la wording du CTA, mettre à jour les
 *     regex `text-name`.
 *   - Le test 4 accepte 3 outcomes (completed/pending/error) car
 *     downstream peut être pending tant que l'app cible n'a pas
 *     l'endpoint attach-member. L'invariant est : pas d'erreur 5xx, pas
 *     de stack trace exposée, message lisible affiché.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';

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

const SECRET_PROSPECTION =
  process.env.HUB_INVITATION_SECRET_PROSPECTION ||
  'staging-invitation-secret-prospection-not-real-e2e';

function uniqueEmail(slug: string): string {
  return makeEmail(`ui-inv-${slug}`);
}

function signBody(secret: string, body: string, ts: number): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

async function adminCreateUser(
  request: APIRequestContext,
  email: string,
  name: string,
): Promise<{ user_id: string; supabase_user_id: string; email: string }> {
  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email, name },
      failOnStatusCode: false,
    }),
  );
  expect(res.status(), `admin create ${email}`).toBe(200);
  return (await res.json()) as {
    user_id: string;
    supabase_user_id: string;
    email: string;
  };
}

async function createProspectionInvite(
  request: APIRequestContext,
  inviter: { user_id: string; email: string },
  inviteeEmail: string,
): Promise<{ token: string; magic_link_url: string }> {
  const ts = Date.now();
  const body = JSON.stringify({
    inviter_user_id: inviter.user_id,
    inviter_email: inviter.email,
    invitee_email: inviteeEmail,
    target_app: 'prospection',
    target_workspace_id: `ws-ui-${RUN_STAMP}`,
    target_role: 'member',
  });
  const sig = signBody(SECRET_PROSPECTION, body, ts);
  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/invitations/create`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': 'prospection',
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
  expect([200, 201]).toContain(res.status());
  return (await res.json()) as { token: string; magic_link_url: string };
}

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
  return ctx;
}

test.describe('Journey 11 — UI invite flow /invite/[token]', () => {
  test('token inconnu (format valide mais absent en DB) → message "introuvable"', async ({
    page,
  }) => {
    const fakeToken = 'f'.repeat(64);
    await page.goto(`${STAGING_URL}/invite/${fakeToken}`);
    await expect(page.getByText(/Invitation introuvable/i)).toBeVisible();
    // Pas d'erreur 500 — un Card avec lien retour
    const loginLink = page.getByRole('link', { name: /Se connecter/i });
    await expect(loginLink).toBeVisible();
  });

  test('token au format invalide (trop court) → "introuvable"', async ({
    page,
  }) => {
    await page.goto(`${STAGING_URL}/invite/short-token-123`);
    await expect(page.getByText(/Invitation introuvable/i)).toBeVisible();
  });

  test('invite valide + user non loggué → bloc sign-in visible', async ({
    page,
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('ui-inviter-anon'),
      'UI Inviter Anon',
    );
    const inviteeEmail = uniqueEmail('ui-anon');
    const created = await createProspectionInvite(
      request,
      inviter,
      inviteeEmail,
    );

    // Page non-loggué : on s'assure de ne pas avoir de cookie
    await page.context().clearCookies();
    await page.goto(`${STAGING_URL}/invite/${created.token}`);

    await expect(page.getByText(/Connectez-vous pour accepter/i)).toBeVisible();
    // Au minimum signup + login existant doivent toujours être visibles
    // (les boutons OAuth sont gated DEPLOY_ENV != 'staging' donc absents en
    // staging Tailscale).
    await expect(page.getByTestId('invite-signup-email')).toBeVisible();
    await expect(page.getByTestId('invite-login-existing')).toBeVisible();

    // Le href signup doit inclure le token et l'email pré-rempli
    const signupHref = await page
      .getByTestId('invite-signup-email')
      .getAttribute('href');
    expect(signupHref).toContain(`invite=${created.token}`);
    expect(signupHref).toContain(
      `email=${encodeURIComponent(inviteeEmail).toLowerCase()}`,
    );
  });

  test('invite valide + user loggué → bouton Accepter + click → outcome lisible', async ({
    page,
    request,
    playwright,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('ui-inviter-logged'),
      'UI Inviter',
    );
    const inviteeEmail = uniqueEmail('ui-logged');
    // Pour que accept marche, l'invitee doit exister côté Hub avec un
    // supabaseUserId (UUID bridge). On le crée d'abord via admin API.
    await adminCreateUser(request, inviteeEmail, 'UI Invitee');

    const created = await createProspectionInvite(
      request,
      inviter,
      inviteeEmail,
    );

    // Mock OAuth login pour récupérer une session Hub valide
    const ctx = await mockOauthLogin(playwright, inviteeEmail);
    // Reporter les cookies dans le page context
    const cookies = await ctx.storageState();
    await page.context().addCookies(cookies.cookies);

    await page.goto(`${STAGING_URL}/invite/${created.token}`);
    // Soit on est sur la confirmation cross-app, soit en mismatch d'email
    // (ne devrait pas car on a loggué le bon email — l'invariant est qu'on
    // voit le bouton Accepter ou un message d'erreur lisible).
    const acceptBtn = page.getByTestId('invite-accept-button');
    await expect(acceptBtn).toBeVisible({ timeout: 10_000 });

    await acceptBtn.click();

    // Attendre l'un des 3 outcomes finaux. On laisse jusqu'à 15s.
    const completed = page.getByText(/Redirection vers/i);
    const pending = page.getByTestId('invite-pending');
    const error = page.getByTestId('invite-error');

    await expect
      .poll(
        async () => {
          if (await completed.isVisible().catch(() => false)) return 'completed';
          if (await pending.isVisible().catch(() => false)) return 'pending';
          if (await error.isVisible().catch(() => false)) return 'error';
          return 'waiting';
        },
        { timeout: 15_000 },
      )
      .toMatch(/completed|pending|error/);
    // Pas d'erreur 500, stack trace ou raw JSON visible
    const html = await page.content();
    expect(html).not.toContain('Internal Server Error');
    expect(html).not.toMatch(/Error: at \w+/);
  });
});
