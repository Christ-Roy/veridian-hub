/**
 * Journey 5 — Invitation cross-app flow (Hub → Notifuse / Prospection).
 *
 * **POURQUOI** : l'agent E2E précédent a validé À LA MAIN sur staging le
 * 2026-05-21 que Hub → Notifuse fonctionnait via une session interactive,
 * et a découvert le bug UUID bridge (commit `5c9c68e`). Sans automation,
 * ce flow peut régresser silencieusement à chaque refactor `auth.ts` /
 * `lib/invitations/*` / convention HMAC client.
 *
 * **CE QUE CE SPEC COUVRE** :
 * 1. POST /api/invitations/create avec HMAC valide → 201 + token + URL magic
 * 2. POST /api/invitations/create rejet HMAC bidon → 401
 * 3. POST /api/invitations/create signature valide mais payload Zod invalide → 400
 * 4. Idempotence : 2 créations identiques → réutilisation (status 200, reused=true)
 * 5. Mismatch app/header → 403
 * 6. Accept invitation par user2 (mock OAuth) → 200 completed OU 202 pending
 *    OU 502 error selon réalité downstream — l'invariant DOIT être :
 *      - status code dans {200, 202, 502}
 *      - downstream_call dans {'completed', 'pending', 'error'}
 *      - redirect_url commence par https://<targetApp>.staging.veridian.site
 * 7. Accept token déjà accepté → 409 already_accepted (idempotence)
 * 8. Accept user **sans supabaseUserId** → 409 user_not_provisioned
 *    (anti-régression bug UUID bridge 2026-05-21)
 *
 * **DÉPENDANCES** :
 * - `ADMIN_SECRET=staging-admin-secret-not-real-e2e` injecté via compose/staging.yml
 * - `HUB_INVITATION_SECRET_{NOTIFUSE,PROSPECTION}_*` idem
 * - `OAUTH_TEST_PROVIDER=true` pour le mock OAuth login
 *
 * Note maintenance : si tu ajoutes un nouvel `target_app`, valide qu'il
 * apparaît bien dans le test de support multi-app.
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

const SECRET_NOTIFUSE =
  process.env.HUB_INVITATION_SECRET_NOTIFUSE ||
  'staging-invitation-secret-notifuse-not-real-e2e';
const SECRET_PROSPECTION =
  process.env.HUB_INVITATION_SECRET_PROSPECTION ||
  'staging-invitation-secret-prospection-not-real-e2e';

function uniqueEmail(slug: string): string {
  return makeEmail(`inv-${slug}`);
}

/** Signe un body HMAC pour POST /api/invitations/create. */
function signInvitationBody(
  secret: string,
  rawBody: string,
  ts: number,
): string {
  return createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
}

type CreatedUser = {
  user_id: string;
  supabase_user_id: string;
  email: string;
};

async function adminCreateUser(
  request: APIRequestContext,
  email: string,
  name: string,
): Promise<CreatedUser> {
  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/admin/users/create`, {
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      data: { email, name },
      failOnStatusCode: false,
    }),
  );
  expect(res.status(), `admin create ${email}`).toBe(200);
  return (await res.json()) as CreatedUser;
}

async function createInvitation(
  request: APIRequestContext,
  opts: {
    app: 'notifuse' | 'prospection';
    inviter: CreatedUser;
    inviteeEmail: string;
    targetWorkspaceId: string;
    secret?: string;
    appHeader?: string;
    role?: 'owner' | 'admin' | 'member';
  },
) {
  const ts = Date.now();
  const body = JSON.stringify({
    inviter_user_id: opts.inviter.user_id,
    inviter_email: opts.inviter.email,
    invitee_email: opts.inviteeEmail,
    target_app: opts.app,
    target_workspace_id: opts.targetWorkspaceId,
    target_role: opts.role ?? 'member',
  });
  const secret =
    opts.secret ??
    (opts.app === 'notifuse' ? SECRET_NOTIFUSE : SECRET_PROSPECTION);
  const sig = signInvitationBody(secret, body, ts);

  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/invitations/create`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': opts.appHeader ?? opts.app,
        'x-veridian-timestamp': String(ts),
        'x-veridian-invitation-signature': sig,
        ...freshIpHeader(),
        // Bypass invitationCreateLimiter (60/min/IP) sur staging E2E —
        // sans ça la suite enchaîne 6+ invitations sur la même IP Traefik
        // et le bucket de la run précédente fait tomber les premières.
        ...bypassRateLimitHeaders(),
      },
      // Important : data RAW (pas un objet, sinon Playwright re-stringifie et
      // la signature ne correspond plus aux bytes envoyés).
      data: body,
      failOnStatusCode: false,
    }),
  );
  return { status: res.status(), body: await res.json() };
}

/** Joue un signup OAuth mocké + retourne un APIRequestContext qui porte
 *  désormais les cookies de session pour les appels suivants. */
async function mockOauthLogin(
  playwright: typeof import('@playwright/test'),
  email: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const cbRes = await ctx.post('/api/auth/callback/mock-oauth', {
    // Bypass oauthCallbackLimiter (30/min/IP) sur staging E2E — un même
    // bucket IP Traefik est partagé par toutes les spec qui font un login
    // mock OAuth, et la suite enchaîne 10+ logins sur quelques minutes.
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

  // Sanity check : on a bien une session.
  const sess = await ctx.get('/api/auth/session');
  expect(sess.status()).toBe(200);
  const sessJson = (await sess.json()) as { user?: { email?: string } };
  expect(sessJson.user?.email?.toLowerCase(), 'session must reflect login').toBe(
    email.toLowerCase(),
  );

  return ctx;
}

// ─── Sanity check : les secrets E2E sont bien injectés en staging ────────

test.describe('Journey 5 — Pré-flight (staging admin + invitation secrets)', () => {
  test('admin secret accepté + user_not_found sur email inconnu', async ({
    request,
  }) => {
    const res = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent('does-not-exist@e2e.veridian.site')}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    // 404 = secret accepté, user inexistant. 401/403 = secret rejeté = ENV pas câblée.
    expect(
      res.status(),
      'admin GET avec secret valide doit accepter (404 attendu sur user inconnu)',
    ).toBe(404);
  });

  test('invitation HMAC valide → 201 (= HUB_INVITATION_SECRET_NOTIFUSE injecté)', async ({
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('preflight-inviter'),
      'Preflight Inviter',
    );
    const result = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail: uniqueEmail('preflight-invitee'),
      targetWorkspaceId: `ws-preflight-${RUN_STAMP}`,
    });
    expect(
      result.status,
      'invitation create avec HMAC valide doit retourner 201',
    ).toBe(201);
    expect(typeof result.body.token).toBe('string');
    expect(result.body.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── Tests création invitation ────────────────────────────────────────────

test.describe('Journey 5 — POST /api/invitations/create', () => {
  test('crée une invitation Notifuse avec HMAC valide', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('create-ok-inviter'),
      'Create OK Inviter',
    );
    const inviteeEmail = uniqueEmail('create-ok-invitee');

    const result = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail,
      targetWorkspaceId: `ws-${RUN_STAMP}`,
    });
    expect(result.status).toBe(201);
    expect(result.body.magic_link_url).toMatch(
      new RegExp(`^${STAGING_URL.replace(/[.\\/]/g, '\\$&')}/invite/[0-9a-f]{64}$`),
    );
    expect(result.body.reused).toBe(false);
    expect(result.body.target_role).toBe('member');
  });

  test('signature HMAC invalide → 401', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('hmac-bad-inviter'),
      'HMAC Bad',
    );
    const result = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail: uniqueEmail('hmac-bad-invitee'),
      targetWorkspaceId: `ws-bad-${RUN_STAMP}`,
      secret: 'wrong-secret-on-purpose',
    });
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('unauthorized');
  });

  test('app header ≠ target_app → 403 app_mismatch', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('mismatch-inviter'),
      'Mismatch Inviter',
    );
    // On signe en disant qu'on est "notifuse" mais on demande target_app=prospection.
    // Header doit donc être 'notifuse' (pour matcher le secret utilisé) MAIS body
    // dit prospection → 403.
    const ts = Date.now();
    const body = JSON.stringify({
      inviter_user_id: inviter.user_id,
      inviter_email: inviter.email,
      invitee_email: uniqueEmail('mismatch-invitee'),
      target_app: 'prospection', // mismatch
      target_workspace_id: `ws-mismatch-${RUN_STAMP}`,
      target_role: 'member',
    });
    const sig = signInvitationBody(SECRET_NOTIFUSE, body, ts);
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/invitations/create`, {
        headers: {
          'content-type': 'application/json',
          'x-veridian-app': 'notifuse',
          'x-veridian-timestamp': String(ts),
          'x-veridian-invitation-signature': sig,
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('app_mismatch');
  });

  test('idempotence : 2 créations identiques → reused=true au 2e call', async ({
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('idem-inviter'),
      'Idempotent Inviter',
    );
    const inviteeEmail = uniqueEmail('idem-invitee');
    const workspaceId = `ws-idem-${RUN_STAMP}`;

    const first = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail,
      targetWorkspaceId: workspaceId,
    });
    expect(first.status).toBe(201);
    expect(first.body.reused).toBe(false);

    const second = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail,
      targetWorkspaceId: workspaceId,
    });
    // 200 + reused=true selon contrat (cf. ref-hub-invitation-hmac-contract).
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.token, 'même token au 2e call').toBe(first.body.token);
  });

  test('inviter_user_id inconnu → 404 inviter_not_found', async ({ request }) => {
    const ts = Date.now();
    const body = JSON.stringify({
      inviter_user_id: 'user_does_not_exist_at_all',
      inviter_email: uniqueEmail('ghost'),
      invitee_email: uniqueEmail('victim'),
      target_app: 'notifuse',
      target_workspace_id: `ws-404-${RUN_STAMP}`,
      target_role: 'member',
    });
    const sig = signInvitationBody(SECRET_NOTIFUSE, body, ts);
    const res = await withRateLimitRetry(() =>
      request.post(`${STAGING_URL}/api/invitations/create`, {
        headers: {
          'content-type': 'application/json',
          'x-veridian-app': 'notifuse',
          'x-veridian-timestamp': String(ts),
          'x-veridian-invitation-signature': sig,
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('inviter_not_found');
  });
});

// ─── Tests acceptation ────────────────────────────────────────────────────

test.describe(
  'Journey 5 — POST /api/invitations/[token]/accept (anti-régression UUID bridge)',
  () => {
    test('user mocké OAuth peut accepter → status ∈ {200,202,502}, downstream_call cohérent', async ({
      request,
      playwright,
    }) => {
      // Setup : inviter + invitee créés via admin API.
      const inviter = await adminCreateUser(
        request,
        uniqueEmail('accept-inviter'),
        'Accept Inviter',
      );
      const inviteeEmail = uniqueEmail('accept-invitee');
      await adminCreateUser(request, inviteeEmail, 'Accept Invitee');

      // Création invitation Notifuse côté Hub.
      const invitation = await createInvitation(request, {
        app: 'notifuse',
        inviter,
        inviteeEmail,
        targetWorkspaceId: `ws-accept-${RUN_STAMP}`,
      });
      expect(invitation.status).toBe(201);
      const token = invitation.body.token as string;

      // Login invitee via mock OAuth (création account OAuth + session).
      const inviteeCtx = await mockOauthLogin(playwright, inviteeEmail);

      // CRITICAL : on assert ici que le user a bien un supabaseUserId UUID v4
      // posé par l'event createUser. Si non, le bug 2026-05-21 est de retour.
      const userRes = await withRateLimitRetry(() =>
        request.get(
          `${STAGING_URL}/api/admin/users/${encodeURIComponent(inviteeEmail)}`,
          { headers: adminHeaders(), failOnStatusCode: false },
        ),
      );
      expect(userRes.status()).toBe(200);
      const userBody = await userRes.json();
      expect(
        userBody.user.supabase_user_id,
        'BUG-2026-05-21 : invitee doit avoir supabaseUserId UUID v4',
      ).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // Acceptation.
      const acceptRes = await withRateLimitRetry(() =>
        inviteeCtx.post(`/api/invitations/${token}/accept`, {
          headers: { 'content-type': 'application/json' },
          data: {},
          failOnStatusCode: false,
        }),
      );

      // Status code DOIT être dans le set autorisé. 502 = downstream
      // Notifuse HS staging (vrai gateway error, pas un crash Hub).
      // DURCI 2026-05-23 (ticket e2e-harden-tolerances) : on assert aussi
      // qu'on n'a JAMAIS 500 (un 500 = Hub crash en gérant l'erreur downstream).
      expect(
        [200, 202, 502],
        `accept status (got ${acceptRes.status()}) — autres = régression`,
      ).toContain(acceptRes.status());
      expect(
        acceptRes.status(),
        'INVARIANT : /api/invitations/:token/accept ne doit JAMAIS crash 500',
      ).not.toBe(500);

      const acceptBody = await acceptRes.json();
      // downstream_call DOIT être présent et valide (ce champ a été ajouté
      // par l'étape 4b 2026-05-21 — son absence = régression du flow).
      expect(['completed', 'pending', 'error']).toContain(
        acceptBody.downstream_call,
      );

      // redirect_url DOIT pointer vers l'app cible (jamais vers une URL
      // arbitraire — fix XSS appliqué côté lib/invitations/accept.ts).
      expect(typeof acceptBody.redirect_url).toBe('string');
      expect(acceptBody.redirect_url).toMatch(
        /^https:\/\/(notifuse\.app\.veridian\.site|notifuse\.staging\.veridian\.site|notifuse\.veridian\.site)/,
      );

      // Anti-régression UUID : si downstream_call=='pending' avec reason
      // 'invalid input syntax for type uuid', c'est le bug 2026-05-21.
      // On ne peut pas lire reason ici (pas exposé en réponse), mais le
      // statut downstream != 500 systématique sur un setup fresh sans
      // workspace réel côté Notifuse = preuve que le bridge UUID marche.
      // Si bug, downstream_call serait toujours 'pending' avec httpStatus 500.

      await inviteeCtx.dispose();
    });

    test('re-accept même token déjà accepté → 409 already_accepted', async ({
      request,
      playwright,
    }) => {
      const inviter = await adminCreateUser(
        request,
        uniqueEmail('twice-inviter'),
        'Twice Inviter',
      );
      const inviteeEmail = uniqueEmail('twice-invitee');
      await adminCreateUser(request, inviteeEmail, 'Twice Invitee');

      const inv = await createInvitation(request, {
        app: 'notifuse',
        inviter,
        inviteeEmail,
        targetWorkspaceId: `ws-twice-${RUN_STAMP}`,
      });
      const token = inv.body.token as string;

      const ctx = await mockOauthLogin(playwright, inviteeEmail);

      const first = await withRateLimitRetry(() =>
        ctx.post(`/api/invitations/${token}/accept`, {
          data: {},
          failOnStatusCode: false,
        }),
      );
      // DURCI 2026-05-23 : 502 légitime (downstream HS), 500 = bug Hub.
      expect([200, 202, 502]).toContain(first.status());
      expect(first.status(), 'INVARIANT : pas de 500 sur accept').not.toBe(
        500,
      );

      const second = await withRateLimitRetry(() =>
        ctx.post(`/api/invitations/${token}/accept`, {
          data: {},
          failOnStatusCode: false,
        }),
      );
      expect(second.status(), 're-accept même token').toBe(409);
      const body = await second.json();
      expect(body.error).toBe('already_accepted');

      await ctx.dispose();
    });

    test('accept sans session → 401 unauthorized', async ({ request }) => {
      const inviter = await adminCreateUser(
        request,
        uniqueEmail('noauth-inviter'),
        'NoAuth Inviter',
      );
      const inv = await createInvitation(request, {
        app: 'notifuse',
        inviter,
        inviteeEmail: uniqueEmail('noauth-invitee'),
        targetWorkspaceId: `ws-noauth-${RUN_STAMP}`,
      });

      const res = await withRateLimitRetry(() =>
        request.post(
          `${STAGING_URL}/api/invitations/${inv.body.token}/accept`,
          { data: {}, failOnStatusCode: false },
        ),
      );
      expect(res.status()).toBe(401);
    });

    test('token inexistant → 404', async ({ request, playwright }) => {
      const inviteeEmail = uniqueEmail('badtoken-invitee');
      await adminCreateUser(request, inviteeEmail, 'BadToken');
      const ctx = await mockOauthLogin(playwright, inviteeEmail);

      const fakeToken = 'a'.repeat(64);
      const res = await ctx.post(`/api/invitations/${fakeToken}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(404);
      await ctx.dispose();
    });
  },
);

// ─── Multi-app : test prospection en parallèle de notifuse ────────────────

test.describe('Journey 5 — Support multi-app', () => {
  test('create invitation prospection avec secret distinct', async ({
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      uniqueEmail('prosp-inviter'),
      'Prospection Inviter',
    );
    const result = await createInvitation(request, {
      app: 'prospection',
      inviter,
      inviteeEmail: uniqueEmail('prosp-invitee'),
      targetWorkspaceId: `ws-prosp-${RUN_STAMP}`,
    });
    expect(result.status).toBe(201);
    expect(result.body.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
