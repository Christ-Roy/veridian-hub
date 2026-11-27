/**
 * Journey 22 — Auto-login Notifuse pour un tenant rattaché par `hub link`.
 *
 * **LE BUG COUVERT** (`todo/2026-07-06-autologin-cross-app-casse.md`) :
 * un workspace Notifuse provisionné EN DIRECT (CLI `notifuse`) puis rattaché
 * au Hub via `hub link --app notifuse` n'avait ni `notifuse_api_key` ni
 * `notifuse_user_email` en base Hub. `POST /api/admin/notifuse/magic-link`
 * répondait donc 409 `Tenant Notifuse workspace not provisioned`, et le
 * dashboard retombait sur `window.open(<url nue Notifuse>)` = écran de login.
 * Constaté en prod le 2026-07-06 sur la démo Céline Gaetan.
 *
 * **CE QUE CE SPEC PROUVE, DE BOUT EN BOUT ET SANS MOCK** :
 *   1. Un workspace Notifuse créé en direct (HMAC, hors Hub) est rattachable.
 *   2. `link-app` refuse désormais un slug qui ne peut pas être un
 *      `workspace_id` Notifuse (au lieu d'accepter un lien mort-né).
 *   3. Le client, avec sa seule session Hub, obtient l'adresse du **rebond
 *      signé** (`/login?next=`), jamais un lien fabriqué par le Hub.
 *   4. Ce rebond est servi par le Hub (HTTP < 400).
 *   5. Un second appel rend la même adresse.
 *
 * **PRÉREQUIS** : `ADMIN_SECRET`, `NOTIFUSE_HUB_API_SECRET` et
 * `NOTIFUSE_STAGING_URL` (défaut `https://notifuse.staging.veridian.site`).
 * Sans le secret Notifuse, les tests sont skippés — on ne peut pas fabriquer
 * l'état de départ (workspace créé hors Hub).
 */

import {
  test,
  expect,
  type APIRequestContext,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

import {
  STAGING_URL,
  ADMIN_SECRET,
  adminHeaders,
  signupHeaders,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';
import { entetesSignature } from '../../lib/hmac/signature-hub';

const NOTIFUSE_URL =
  process.env.NOTIFUSE_STAGING_URL ?? 'https://notifuse.staging.veridian.site';
const NOTIFUSE_HUB_SECRET =
  process.env.NOTIFUSE_HUB_API_SECRET_STAGING ??
  process.env.NOTIFUSE_HUB_API_SECRET ??
  '';

const PASSWORD = 'StagingAutologin!2026';

/** Garde-fou : ce spec écrit côté Notifuse, jamais sur l'instance de prod. */
function assertNotProd(): void {
  if (NOTIFUSE_URL.includes('.app.veridian.site')) {
    throw new Error(
      `22-autologin: refus de cibler la prod Notifuse (${NOTIFUSE_URL}). Ce spec provisionne des workspaces.`,
    );
  }
}

/**
 * Appel HMAC direct à Notifuse — simule le CLI `notifuse` qui provisionne un
 * workspace SANS passer par le Hub. C'est l'état de départ du bug.
 * Signature : `lib/hmac/signature-hub.ts` (v2), comme le Hub.
 */
async function notifuseHmac(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const raw = body == null ? '' : JSON.stringify(body);
  // Le signataire du Hub, en v2 (Mail le vérifie depuis bd3e66dc) : jamais un HMAC refait ici.
  const headers: Record<string, string> = entetesSignature({ secret: NOTIFUSE_HUB_SECRET, methode: method, url: `${NOTIFUSE_URL}${path}`, corps: raw, app: 'notifuse', env: { HMAC_V2_APPS: 'notifuse' } as NodeJS.ProcessEnv });
  if (raw) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${NOTIFUSE_URL}${path}`, {
    method,
    headers,
    body: raw && method !== 'GET' ? raw : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

/** `workspace_id` Notifuse valide : `[a-z0-9]{1,20}`. */
function uniqueWorkspaceId(): string {
  return `e2eal${Date.now().toString(36)}`.replace(/[^a-z0-9]/g, '').slice(0, 20);
}

async function signupCredentials(email: string): Promise<void> {
  const res = await withRateLimitRetry<Response>(() =>
    fetch(`${STAGING_URL}/api/auth/signup`, {
      method: 'POST',
      headers: signupHeaders(),
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect([200, 201], `signup ${email} status=${res.status}`).toContain(res.status);
}

/**
 * Session Auth.js credentials — le client agit avec SA session, pas en admin.
 *
 * Le paramètre est typé depuis le fixture `playwright` de Playwright Test.
 * Les specs plus anciennes le typent `typeof import('@playwright/test')`, ce
 * qui ne correspond PAS au type réel du fixture (playwright-core) et produit
 * une erreur TS2345 — on ne reproduit pas ce défaut ici.
 */
async function loginCredentials(
  playwright: PlaywrightWorkerArgs['playwright'],
  email: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const res = await ctx.post('/api/auth/callback/credentials', {
    form: {
      csrfToken,
      email,
      password: PASSWORD,
      callbackUrl: `${STAGING_URL}/dashboard`,
      json: 'true',
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  expect(res.status(), `login ${email}`).toBeLessThan(400);

  const sess = await ctx.get('/api/auth/session');
  const body = (await sess.json()) as { user?: { email?: string } };
  expect(body.user?.email?.toLowerCase(), 'session établie').toBe(email.toLowerCase());
  return ctx;
}

/** Rattache l'app au compte Hub — équivalent de `hub link --app notifuse`. */
async function hubLinkNotifuse(
  request: APIRequestContext,
  params: { email: string; workspaceId: string; ownerEmail?: string },
) {
  return request.post(`${STAGING_URL}/api/admin/tenants/link-app`, {
    headers: adminHeaders(),
    failOnStatusCode: false,
    data: {
      user_email: params.email,
      app: 'notifuse',
      external_tenant_id: params.workspaceId,
      external_tenant_slug: params.workspaceId,
      tenant_name: `E2E autologin ${params.workspaceId}`,
      plan: 'free',
      ...(params.ownerEmail ? { owner_email: params.ownerEmail } : {}),
    },
  });
}

const secretsReady = Boolean(ADMIN_SECRET) && Boolean(NOTIFUSE_HUB_SECRET);

test.describe('Journey 22 — Auto-login Notifuse après `hub link`', () => {
  test.skip(
    !secretsReady,
    'ADMIN_SECRET + NOTIFUSE_HUB_API_SECRET requis pour fabriquer l’état de départ',
  );

  test('un tenant rattaché par `hub link` ouvre Mail par le rebond', async ({
    request,
    playwright,
  }) => {
    assertNotProd();
    test.setTimeout(120_000);

    const workspaceId = uniqueWorkspaceId();
    const email = makeEmail(`autologin-${workspaceId}`);

    // ─── 1. User Hub (identité prouvée par `hub_user_id`, CONTRAT-HUB §5.19.7) ──
    await signupCredentials(email);
    const hubUserId = await resolveHubUserId(request, email);

    // ─── 2. Workspace créé EN DIRECT côté Notifuse (hors Hub) ───────────
    // Reproduit le CLI `notifuse` : le Hub ne voit jamais passer la clé API.
    // Mail désigne son propriétaire par `owner_hub_user_id`, jamais par l'adresse seule.
    const provision = await notifuseHmac('POST', '/api/tenants/provision', {
      tenant_id: workspaceId,
      owner_email: email,
      owner_hub_user_id: hubUserId,
      workspace_name: `E2E autologin ${workspaceId}`,
      plan: 'free',
      metadata: { hub_user_id: hubUserId },
    });
    expect(provision.status, `provision Notifuse: ${JSON.stringify(provision.json)}`).toBe(200);
    expect(provision.json.created, 'workspace fraîchement créé').toBe(true);

    // ─── 3. `hub link --app notifuse` ───────────────────────────────────
    const link = await hubLinkNotifuse(request, { email, workspaceId });
    expect(link.status(), `link-app: ${await link.text()}`).toBe(200);

    // ─── 4. LE TEST DE RÉGRESSION : le client demande son auto-login ────
    // Avant le fix : 409 `Tenant Notifuse workspace not provisioned`, parce
    // que ni notifuse_api_key ni notifuse_user_email n'étaient en base.
    const clientCtx = await loginCredentials(playwright, email);
    try {
      const magic = await clientCtx.post('/api/admin/notifuse/magic-link', {
        data: { tenantId: await resolveTenantId(request, email) },
        failOnStatusCode: false,
      });

      const magicBody = (await magic.json()) as { url?: string; error?: string; reason?: string };
      expect(
        magic.status(),
        `magic-link doit répondre 200 (reçu ${magic.status()}: ${JSON.stringify(magicBody)})`,
      ).toBe(200);
      // Plus de lien fabriqué par le Hub : le rebond signé, qui demande la session de la personne.
      expect(magicBody.url, 'adresse du rebond présente').toMatch(/^\/login\?next=/);
      expect(JSON.stringify(magicBody)).not.toContain('/veridian/auto-login');

      // ─── 5. Le rebond est servi par le Hub ────────────────────────────
      const followed = await clientCtx.get(magicBody.url!, { maxRedirects: 0, failOnStatusCode: false });
      expect(
        followed.status(),
        `le rebond doit être servi (reçu ${followed.status()})`,
      ).toBeLessThan(400);

      // ─── 6. Un 2e appel rend la même adresse (aucun jeton à usage unique côté Hub) ──
      const second = await clientCtx.post('/api/admin/notifuse/magic-link', {
        data: { tenantId: await resolveTenantId(request, email) },
        failOnStatusCode: false,
      });
      expect(second.status()).toBe(200);
      expect(((await second.json()) as { url?: string }).url).toBe(magicBody.url);
    } finally {
      await clientCtx.dispose();
      // Nettoyage staging : on ne laisse pas traîner le workspace de test.
      await notifuseHmac('POST', `/api/tenants/${workspaceId}/suspend`, {
        tenant_id: workspaceId,
        reason: 'e2e-cleanup',
      }).catch(() => undefined);
    }
  });

  test('`link-app` refuse un slug impossible côté Notifuse', async ({ request }) => {
    // Avant le fix, ce lien était accepté et produisait un tenant dont
    // l'auto-login échouait pour toujours — sans aucun signal à la création.
    const email = makeEmail('autologin-badslug');
    await signupCredentials(email);

    const res = await hubLinkNotifuse(request, {
      email,
      workspaceId: 'slug-avec-hyphens-et-beaucoup-trop-long',
    });

    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).error).toBe('invalid_notifuse_workspace_id');
  });
});

/** Récupère l'id du Tenant Hub créé par `link-app` (admin API). */
async function resolveTenantId(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const res = await request.get(
    `${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`,
    { headers: adminHeaders(), failOnStatusCode: false },
  );
  expect(res.status(), `admin users lookup ${email}`).toBe(200);
  const body = (await res.json()) as {
    tenants?: Array<{ id: string }>;
    tenant?: { id: string };
  };
  const tenantId = body.tenant?.id ?? body.tenants?.[0]?.id;
  expect(tenantId, `tenant Hub introuvable pour ${email}: ${JSON.stringify(body)}`).toBeTruthy();
  return tenantId!;
}

/** `hub_user_id` (`supabase_user_id`) du compte, par l'API admin. */
async function resolveHubUserId(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.get(`${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`, { headers: adminHeaders(), failOnStatusCode: false });
  expect(res.status(), `admin users lookup ${email}`).toBe(200);
  const body = (await res.json()) as { user?: { supabase_user_id?: string | null } };
  expect(body.user?.supabase_user_id, `hub_user_id introuvable pour ${email}`).toBeTruthy();
  return body.user!.supabase_user_id!;
}
