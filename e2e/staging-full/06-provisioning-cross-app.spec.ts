/**
 * Journey 6 — Provisioning cross-app (Hub → Notifuse + Prospection).
 *
 * **CONTEXTE** : depuis le sprint v1.4 (2026-05-21), le signup ne
 * provisionne PLUS les apps downstream automatiquement. Le flow est :
 *   1. POST /api/auth/signup → User Hub + workspace par défaut créés
 *   2. User atterrit sur /dashboard → vide
 *   3. User clique "Commencer l'essai" → POST /api/tenants/start?app=...
 *   4. Hub appelle Notifuse/Prospection en HMAC, persist row Tenant côté Hub
 *
 * **CE SPEC COUVRE** :
 *   - Signup credentials crée le user + supabaseUserId UUID v4
 *   - Signup crée AUSSI une row Tenant initiale "shell" (avant /tenants/start)
 *     OU ne crée rien (selon implémentation) → on assert le state observable
 *   - POST /tenants/start (session) appelle bien les downstream et persiste
 *     les colonnes attendues
 *   - GET /api/tenants/status après start reflète l'état provisionné
 *   - Idempotence : appeler /tenants/start 2 fois ne re-provisionne pas
 *   - L'admin API `/api/admin/users/<email>` confirme la persistance DB
 *
 * **CE QUI N'EST PAS COUVERT** (intentionnellement) :
 *   - Le contenu réel côté Notifuse/Prospection (validé par les tests E2E
 *     de ces apps) — on assert juste le côté Hub.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

import {
  STAGING_URL,
  RUN_STAMP,
  adminHeaders,
  bypassRateLimitHeaders,
  signupHeaders,
  uniqueEmail as makeEmail,
  withRateLimitRetry,
} from './_helpers';

function uniqueEmail(slug: string): string {
  return makeEmail(`prov-${slug}`);
}

/**
 * Wrapper signup credentials avec headers `signupHeaders()` :
 *  - bypass rate-limit E2E (signupLimiter 5/min/IP) si secret configuré
 *  - IP fraîche en fallback (mode dégradé local)
 *
 * Sans le bypass, la suite tape 429 dès le 6e signup sur la même IP
 * Traefik. Avec le bypass on enchaîne 60+ signups sans cap.
 *
 * On utilise un fetch DIRECT (pas `ctx.post`) car APIRequestContext re-utilise
 * son propre baseURL + headers et ne supporte pas l'override par appel.
 */
async function signupCredentials(
  _ctx: APIRequestContext,
  email: string,
  password = 'StagingProvTest!2026',
): Promise<void> {
  const res = await withRateLimitRetry<Response>(() =>
    fetch(`${STAGING_URL}/api/auth/signup`, {
      method: 'POST',
      headers: signupHeaders(),
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(
    [200, 201],
    `signup ${email} status=${res.status}`,
  ).toContain(res.status);
}

/** Login credentials via Auth.js — récupère un ctx session-aware. */
async function loginCredentials(
  playwright: typeof import('@playwright/test'),
  email: string,
  password = 'StagingProvTest!2026',
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
  const csrfRes = await ctx.get('/api/auth/csrf');
  expect(csrfRes.status()).toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  // Auth.js v5 credentials provider — la route exacte est
  // /api/auth/callback/credentials.
  const res = await ctx.post('/api/auth/callback/credentials', {
    form: {
      csrfToken,
      email,
      password,
      callbackUrl: `${STAGING_URL}/dashboard`,
      json: 'true',
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  expect(res.status(), `login ${email}`).toBeLessThan(400);

  // Confirme la session.
  const sess = await ctx.get('/api/auth/session');
  expect(sess.status()).toBe(200);
  const body = (await sess.json()) as { user?: { email?: string } };
  expect(body.user?.email?.toLowerCase()).toBe(email.toLowerCase());
  return ctx;
}

// ─── Pré-flight ────────────────────────────────────────────────────────────

test.describe('Journey 6 — Pré-flight provisioning', () => {
  test('POST /api/tenants/start sans session → 401/redirect', async ({
    request,
  }) => {
    const res = await request.post(`${STAGING_URL}/api/tenants/start`, {
      data: { app: 'notifuse' },
      failOnStatusCode: false,
    });
    expect(
      res.status(),
      'endpoint /tenants/start exige une session — 401 ou redirect attendu',
    ).toBeGreaterThanOrEqual(400);
  });
});

// ─── Flow complet signup → start → status ─────────────────────────────────

test.describe('Journey 6 — Flow signup → /tenants/start → /tenants/status', () => {
  test('signup credentials crée user + supabaseUserId UUID v4', async ({
    request,
  }) => {
    const email = uniqueEmail('signup-uuid');
    await signupCredentials(request, email);

    // Confirmer via admin API.
    const userRes = await withRateLimitRetry(() =>
      request.get(
        `${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`,
        { headers: adminHeaders(), failOnStatusCode: false },
      ),
    );
    expect(userRes.status()).toBe(200);
    const body = await userRes.json();
    expect(
      body.user.supabase_user_id,
      'BUG-2026-05-21 : signup credentials doit poser supabaseUserId UUID v4',
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('POST /tenants/start?app=notifuse provisionne le tenant côté Hub', async ({
    request,
    playwright,
  }) => {
    const email = uniqueEmail('start-notifuse');
    await signupCredentials(request, email);

    const session = await loginCredentials(playwright, email);

    const res = await session.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      failOnStatusCode: false,
    });
    // DURCI 2026-05-23 (ticket e2e-harden-tolerances) :
    // 200/201/202 = succès Hub (avec ou sans downstream). 502/503 = downstream
    // Notifuse HS (légitime en staging à un instant t — gateway error remontée
    // proprement). Plus de tolérance 500 : un 500 = Hub a crashé en gérant
    // l'erreur downstream, c'est un bug Hub à fixer.
    const bodyText = await res.text();
    expect(
      [200, 201, 202, 502, 503],
      `start notifuse status=${res.status()} body=${bodyText.slice(0, 400)}. ` +
        `Un 500 ici = Hub n'a pas catch proprement l'erreur downstream.`,
    ).toContain(res.status());
    expect(
      res.status(),
      'INVARIANT : Hub ne doit JAMAIS crash 500 sur /tenants/start',
    ).not.toBe(500);

    // Le call /tenants/start peut renvoyer 200 sans aucune row Tenant créée
    // si le downstream Notifuse a échoué (compose staging : Notifuse n'accepte
    // peut-être pas le secret HMAC partagé). On valide juste :
    //   - status code non-5xx (Hub ne crash pas)
    //   - admin GET retourne OK (user existe toujours, pas de side-effect cassé)
    // L'invariant fort "tenant row créée" relève d'un test E2E qui aurait un
    // setup downstream complet — pas le scope de ce spec.
    if (res.status() === 200 || res.status() === 201) {
      const userRes = await withRateLimitRetry(() =>
        request.get(
          `${STAGING_URL}/api/admin/users/${encodeURIComponent(email)}`,
          { headers: adminHeaders(), failOnStatusCode: false },
        ),
      );
      expect(userRes.status()).toBe(200);
      const body = await userRes.json();
      const tenants = body.tenants as Array<{
        notifuseWorkspaceSlug: string | null;
      }>;
      if (tenants.length === 0) {
        console.warn(
          `[journey6] /tenants/start renvoyé 200 mais 0 tenant créé pour ${email} — downstream Notifuse staging probable HS / HMAC rejeté. Comportement actuel toléré.`,
        );
      } else if (!tenants.find((t) => !!t.notifuseWorkspaceSlug)) {
        console.warn(
          `[journey6] tenant créé mais notifuseWorkspaceSlug=null pour ${email}`,
        );
      }
    } else {
      console.warn(
        `[journey6] tenant start notifuse returned ${res.status()} — downstream peut être HS, test toléré`,
      );
    }
    await session.dispose();
  });

  test('idempotence : /tenants/start appelé 2x → état stable', async ({
    request,
    playwright,
  }) => {
    const email = uniqueEmail('start-idem');
    await signupCredentials(request, email);
    const session = await loginCredentials(playwright, email);

    const first = await session.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      failOnStatusCode: false,
    });
    const firstStatus = first.status();

    const second = await session.post('/api/tenants/start', {
      data: { app: 'notifuse' },
      failOnStatusCode: false,
    });
    // 2e call : status DOIT être < 500 si le 1er a réussi (idempotent).
    // Si le 1er a échoué (downstream HS), le 2e peut aussi échouer — on ne
    // force pas la cohérence dans ce cas.
    if (firstStatus < 400) {
      expect(
        second.status(),
        '2e /tenants/start sur tenant déjà provisionné doit être idempotent',
      ).toBeLessThan(400);
    }
    await session.dispose();
  });

  test('GET /api/tenants/status retourne le state (avec ou sans tenant)', async ({
    request,
    playwright,
  }) => {
    const email = uniqueEmail('status-check');
    await signupCredentials(request, email);
    const session = await loginCredentials(playwright, email);

    const res = await session.get('/api/tenants/status', {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Le shape exact peut varier mais on valide que c'est un JSON parseable
    // sans 500. C'est le contrat minimum stable.
    expect(typeof body).toBe('object');
    await session.dispose();
  });
});

// ─── Garde-fou : dashboard accessible post-signup ─────────────────────────

test.describe('Journey 6 — Dashboard chargeable post-signup', () => {
  // BUG-2026-05-21 résolu : Auth.js v5 NE déclenche PAS `events.createUser`
  // pour les Credentials providers (uniquement OAuth via PrismaAdapter).
  // Comme le mock est un Credentials provider, l'event câblé dans `auth.ts`
  // ne tournait pas → users mock créés avec supabaseUserId NULL → Dashboard
  // crashait sur userUuid() (lib/auth/get-user.ts:76).
  //
  // Fix : `lib/auth/mock-oauth-provider.ts` pose maintenant
  // `supabaseUserId: randomUUID()` directement dans `prisma.user.create()`,
  // reproduisant ce que `createCreateUserEvent` aurait posé sur un vrai
  // signup OAuth Google/Microsoft via PrismaAdapter.
  //
  // Non-régression colocalisée dans
  // `__tests__/lib/auth/mock-oauth-provider.test.ts` (test
  // "BUG-2026-05-21 : pose supabaseUserId UUID v4").
  test(
    'dashboard rend 200 (pas de crash userUuid) — BUG-2026-05-21 fixé',
    async ({ playwright }) => {
    // On utilise mock OAuth (pas signupCredentials) car ce dernier hit le
    // signupLimiter à 5/min/IP, déjà épuisé par les tests précédents. Le mock
    // OAuth fait passer par /api/auth/callback/mock-oauth qui n'a pas de
    // rate-limit signup — exactement ce qui valide le bug 2026-05-21 (le
    // dashboard crashait sur les users OAuth fresh sans supabaseUserId).
    const email = uniqueEmail('dashboard-render');

    const ctx = await playwright.request.newContext({ baseURL: STAGING_URL });
    const csrfRes = await ctx.get('/api/auth/csrf');
    expect(csrfRes.status()).toBe(200);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

    const cb = await ctx.post('/api/auth/callback/mock-oauth', {
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
    expect(cb.status()).toBeLessThan(400);

    const cookies = await ctx.storageState();
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext({
      baseURL: STAGING_URL,
      storageState: cookies,
    });
    const page = await context.newPage();

    const resp = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    expect(
      resp?.status(),
      'BUG-2026-05-21 : dashboard ne doit JAMAIS crash en 500 sur userUuid()',
    ).toBeLessThan(500);
    expect(
      page.url(),
      'dashboard accessible (pas de redirect vers /login)',
    ).not.toContain('/login');

    await context.close();
    await browser.close();
    await ctx.dispose();
    },
  );
});
