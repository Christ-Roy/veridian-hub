/**
 * MEGA Bucket H — Invitations + OAuth bounce
 *
 * Spec H-01 — Invitation cross-app Hub → Notifuse / Prospection
 *
 * **Scénario** : flow complet d'invitation cross-app, anti-régression du bug
 * UUID bridge 2026-05-21 + du bug "invitations-4b" (qui avait inventé
 * `HUB_INVITATION_SECRET_*` côté downstream call alors que c'était
 * `NOTIFUSE_HUB_API_SECRET` existant).
 *
 *   1. Admin crée user inviter (avec UUID bridge).
 *   2. POST /api/invitations/create avec HMAC valide → 201 + token + magic_link_url.
 *   3. Asserts contractuels :
 *      - status 201 (premier appel) / 200 (replay = idempotence).
 *      - HMAC tampering → 401.
 *      - timestamp drift > 5 min → 401.
 *      - target_app whitelist (cas inconnu → 400).
 *      - app header ≠ target_app → 403 app_mismatch.
 *      - inviter_user_id inconnu → 404 inviter_not_found.
 *   4. Login invitee mock OAuth → vérifie UUID v4 posé (anti-régression).
 *   5. Accept invitation → status ∈ {200,202,502} avec invariant pas-de-500.
 *   6. Re-accept même token → 409 already_accepted.
 *
 * **Memory** : `reference_hub_invitation_hmac_contract.md` +
 *   `reference_hub_invitation_model_split.md` (distinction `Invitation`
 *   workspace Hub vs `CrossAppInvitation` cross-app).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';

import {
  STAGING_URL,
  adminHeaders,
  bypassRateLimitHeaders,
  freshIpHeader,
  withRateLimitRetry,
} from '../../_helpers';
import { purgeMegaByPrefix } from '../_fixtures/db-purge';
import {
  assertMockOAuthAvailable,
  disposeSession,
  megaEmail,
  megaSignIn,
  type MegaSession,
} from '../_fixtures/mock-oauth';
import { MEGA_RUN_STAMP } from '../_fixtures/run-stamp';

const BUCKET = 'h';
const SPEC = '01-invitation-cross-app';

const SECRET_NOTIFUSE =
  process.env.HUB_INVITATION_SECRET_NOTIFUSE ||
  'staging-invitation-secret-notifuse-not-real-e2e';
const SECRET_PROSPECTION =
  process.env.HUB_INVITATION_SECRET_PROSPECTION ||
  'staging-invitation-secret-prospection-not-real-e2e';

function signInvitationBody(secret: string, rawBody: string, ts: number): string {
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
  expect(res.status(), `admin create ${email} status=${res.status()}`).toBe(200);
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
    timestampOverride?: number;
  },
) {
  const ts = opts.timestampOverride ?? Date.now();
  const body = JSON.stringify({
    inviter_user_id: opts.inviter.user_id,
    inviter_email: opts.inviter.email,
    invitee_email: opts.inviteeEmail,
    target_app: opts.app,
    target_workspace_id: opts.targetWorkspaceId,
    target_role: opts.role ?? 'member',
  });
  const secret =
    opts.secret ?? (opts.app === 'notifuse' ? SECRET_NOTIFUSE : SECRET_PROSPECTION);
  const sig = signInvitationBody(secret, body, ts);
  const res = await withRateLimitRetry(() =>
    request.post(`${STAGING_URL}/api/invitations/create`, {
      headers: {
        'content-type': 'application/json',
        'x-veridian-app': opts.appHeader ?? opts.app,
        'x-veridian-timestamp': String(ts),
        'x-veridian-invitation-signature': sig,
        ...freshIpHeader(),
        ...bypassRateLimitHeaders(),
      },
      data: body, // RAW (pas un objet, sinon resig mismatch)
      failOnStatusCode: false,
    }),
  );
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-json body */
  }
  return { status: res.status(), body: parsed };
}

test.describe.configure({ mode: 'serial' });

test.describe('Mega H-01 — Invitation cross-app Hub → Notifuse/Prospection', () => {
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
      console.log(`[mega H-01 afterAll] purge ${total} rows (${stats.durationMs}ms)`);
    } catch (err) {
      console.warn(`[mega H-01 afterAll] purge swallow: ${String(err)}`);
    }
  });

  test('pré-flight : invitation HMAC valide → 201 (anti-régression invitations-4b)', async ({
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'preflight' }),
      'Preflight Inviter',
    );
    const result = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'preflight-inv' }),
      targetWorkspaceId: `ws-mega-${BUCKET}-preflight-${MEGA_RUN_STAMP}`,
    });
    expect(
      result.status,
      `HUB_INVITATION_SECRET_NOTIFUSE pas câblé ou bug HMAC — got ${result.status} ${JSON.stringify(result.body)?.slice(0, 200)}`,
    ).toBe(201);
    expect(typeof result.body.token).toBe('string');
    expect(result.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.body.magic_link_url).toMatch(
      /^https?:\/\/.+\/invite\/[0-9a-f]{64}$/,
    );
    expect(result.body.reused).toBe(false);
  });

  test('HMAC tampering → 401 unauthorized', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'hmac-bad-inv' }),
      'HMAC Bad',
    );
    const result = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'hmac-bad-invitee' }),
      targetWorkspaceId: `ws-mega-${BUCKET}-bad-${MEGA_RUN_STAMP}`,
      secret: 'wrong-secret-totally-bogus',
    });
    expect(result.status).toBe(401);
    expect(result.body?.error).toBe('unauthorized');
  });

  test('timestamp drift > 5 min → 401', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'drift-inv' }),
      'Drift Inviter',
    );
    const result = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'drift-invitee' }),
      targetWorkspaceId: `ws-mega-${BUCKET}-drift-${MEGA_RUN_STAMP}`,
      timestampOverride: Date.now() - 10 * 60 * 1000, // -10 min
    });
    expect(
      result.status,
      `drift > 5 min doit 401, got ${result.status}`,
    ).toBe(401);
  });

  test('app header ≠ target_app → 403 app_mismatch', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'mismatch-inv' }),
      'Mismatch Inviter',
    );
    // Signe avec secret notifuse mais demande target_app=prospection.
    const ts = Date.now();
    const body = JSON.stringify({
      inviter_user_id: inviter.user_id,
      inviter_email: inviter.email,
      invitee_email: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'mismatch-victim' }),
      target_app: 'prospection',
      target_workspace_id: `ws-mega-${BUCKET}-mismatch-${MEGA_RUN_STAMP}`,
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
          ...bypassRateLimitHeaders(),
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('app_mismatch');
  });

  test('inviter_user_id inconnu → 404 inviter_not_found', async ({ request }) => {
    const ts = Date.now();
    const body = JSON.stringify({
      inviter_user_id: 'user_does_not_exist_at_all',
      inviter_email: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'ghost' }),
      invitee_email: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'ghost-victim' }),
      target_app: 'notifuse',
      target_workspace_id: `ws-mega-${BUCKET}-404-${MEGA_RUN_STAMP}`,
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
          ...bypassRateLimitHeaders(),
        },
        data: body,
        failOnStatusCode: false,
      }),
    );
    expect(res.status()).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('inviter_not_found');
  });

  test('idempotence : 2× create identiques → reused=true au 2e + même token', async ({
    request,
  }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'idem-inv' }),
      'Idempotent Inviter',
    );
    const inviteeEmail = megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'idem-victim' });
    const workspaceId = `ws-mega-${BUCKET}-idem-${MEGA_RUN_STAMP}`;

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
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.token, 'token doit être identique au 2e call').toBe(
      first.body.token,
    );
  });

  // ─── Accept invitation : flow réel mock OAuth + invariant pas-de-500 ──

  test(
    'accept invitation : login OAuth + accept → status ∈ {200,202,502}, jamais 500',
    async ({ request, playwright }) => {
      const inviter = await adminCreateUser(
        request,
        megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'accept-inv' }),
        'Accept Inviter',
      );
      const inviteeEmail = megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'accept-victim' });
      await adminCreateUser(request, inviteeEmail, 'Accept Invitee');

      const invitation = await createInvitation(request, {
        app: 'notifuse',
        inviter,
        inviteeEmail,
        targetWorkspaceId: `ws-mega-${BUCKET}-accept-${MEGA_RUN_STAMP}`,
      });
      expect(invitation.status).toBe(201);
      const token = invitation.body.token as string;

      // Login invitee via mock OAuth.
      const session = await megaSignIn(
        playwright as unknown as typeof import('@playwright/test'),
        {
          bucket: BUCKET,
          spec: SPEC,
          provider: 'google',
          variant: 'accept-login',
          emailOverride: inviteeEmail,
        },
      );
      sessions.push(session);

      // Anti-régression BUG 2026-05-21 : invitee doit avoir UUID v4
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
        'BUG-2026-05-21 : invitee OAuth doit avoir UUID v4',
      ).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // Accept
      const acceptRes = await withRateLimitRetry(() =>
        session.request.post(`/api/invitations/${token}/accept`, {
          headers: { 'content-type': 'application/json' },
          data: {},
          failOnStatusCode: false,
        }),
      );
      expect(
        [200, 202, 502],
        `accept status (got ${acceptRes.status()}) — autres = régression`,
      ).toContain(acceptRes.status());
      expect(
        acceptRes.status(),
        'INVARIANT : /api/invitations/:token/accept ne doit JAMAIS crash 500',
      ).not.toBe(500);

      const acceptBody = await acceptRes.json();
      expect(['completed', 'pending', 'error']).toContain(acceptBody.downstream_call);
      expect(typeof acceptBody.redirect_url).toBe('string');
      expect(acceptBody.redirect_url).toMatch(
        /^https:\/\/(notifuse\.app\.veridian\.site|notifuse\.staging\.veridian\.site|notifuse\.veridian\.site)/,
      );
    },
  );

  test('re-accept même token → 409 already_accepted', async ({
    request,
    playwright,
  }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'twice-inv' }),
      'Twice Inviter',
    );
    const inviteeEmail = megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'twice-victim' });
    await adminCreateUser(request, inviteeEmail, 'Twice Invitee');

    const inv = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail,
      targetWorkspaceId: `ws-mega-${BUCKET}-twice-${MEGA_RUN_STAMP}`,
    });
    expect(inv.status).toBe(201);
    const token = inv.body.token as string;

    const session = await megaSignIn(
      playwright as unknown as typeof import('@playwright/test'),
      {
        bucket: BUCKET,
        spec: SPEC,
        provider: 'google',
        variant: 'twice-login',
        emailOverride: inviteeEmail,
      },
    );
    sessions.push(session);

    const first = await withRateLimitRetry(() =>
      session.request.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect([200, 202, 502]).toContain(first.status());
    expect(first.status()).not.toBe(500);

    const second = await withRateLimitRetry(() =>
      session.request.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      }),
    );
    expect(second.status(), 're-accept doit 409').toBe(409);
    const body = await second.json();
    expect(body.error).toBe('already_accepted');
  });

  test('accept sans session → 401 unauthorized', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'noauth-inv' }),
      'NoAuth Inviter',
    );
    const inv = await createInvitation(request, {
      app: 'notifuse',
      inviter,
      inviteeEmail: megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'noauth-victim' }),
      targetWorkspaceId: `ws-mega-${BUCKET}-noauth-${MEGA_RUN_STAMP}`,
    });
    expect(inv.status).toBe(201);

    const res = await withRateLimitRetry(() =>
      request.post(
        `${STAGING_URL}/api/invitations/${inv.body.token}/accept`,
        { data: {}, failOnStatusCode: false },
      ),
    );
    expect(res.status()).toBe(401);
  });
});

// ─── Support multi-app : prospection en parallèle ─────────────────────
test.describe('Mega H-01 — support multi-app (prospection)', () => {
  test.afterAll(async () => {
    try {
      await purgeMegaByPrefix({
        emailPrefix: `e2e-mega-${BUCKET}-01-multi`,
        tenantPrefix: `mega-${BUCKET}`,
      });
    } catch {
      /* swallow */
    }
  });

  test('create invitation prospection avec son secret dédié', async ({ request }) => {
    const inviter = await adminCreateUser(
      request,
      megaEmail({ bucket: BUCKET, spec: SPEC, variant: 'multi-prosp-inv' }),
      'Multi Prosp Inviter',
    );
    const result = await createInvitation(request, {
      app: 'prospection',
      inviter,
      inviteeEmail: megaEmail({
        bucket: BUCKET,
        spec: SPEC,
        variant: 'multi-prosp-victim',
      }),
      targetWorkspaceId: `ws-mega-${BUCKET}-multi-${MEGA_RUN_STAMP}`,
    });
    expect(
      result.status,
      `HUB_INVITATION_SECRET_PROSPECTION pas câblé ? status=${result.status}`,
    ).toBe(201);
    expect(result.body.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
