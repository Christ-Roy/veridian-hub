/**
 * MEGA fixture — `mock-oauth.ts`
 *
 * Wrapper réutilisable pour signup/login via le mock OAuth provider Auth.js
 * activé en staging (cf. memory `reference_mock_oauth_provider.md` + spec
 * existant `04-oauth-flows.spec.ts`).
 *
 * **POURQUOI** : la moitié des buckets MEGA (A, B, C, D, E, F, G, H) ont
 * besoin d'un user loggué pour démarrer leur scénario. Plutôt que de
 * recopier 50× le même `getCsrfToken + POST callback/mock-oauth`, on
 * factorise ici une API claire :
 *
 *   const session = await megaSignIn(playwright, {
 *     bucket: 'A',
 *     spec: '01-signup-oauth-google',
 *     provider: 'google',
 *   });
 *   // session.email, session.request (APIRequestContext cookie-aware)
 *
 * Le helper :
 *   - génère un email unique formaté `e2e-mega-<bucket>-<spec>-<RUN_STAMP>@...`
 *   - récupère un CSRF token Auth.js v5
 *   - poste le callback mock-oauth avec bypass rate-limit
 *   - retourne un APIRequestContext porteur des cookies de session
 *
 * **GARDE-FOU** : `OAUTH_TEST_PROVIDER=true` doit être posé côté compose
 * staging (sinon `mock-oauth` n'est pas listé dans `/api/auth/providers`).
 * On ne fail PAS ici si le flag manque — c'est aux specs de check via
 * `assertMockOAuthAvailable()` qu'on expose en parallèle.
 *
 * **DEPLOY_ENV strict** : on REFUSE de tourner si la URL cible ressemble à
 * de la prod (`hub.veridian.site` sans `.staging.`). Triple garde-fou
 * cumulé avec le check côté Hub (`auth.config.ts` skip mock-oauth si
 * DEPLOY_ENV !== 'staging' && DEPLOY_ENV !== 'development') et avec le
 * script `scripts/ci/check-no-test-provider-in-prod.sh`.
 */
import { expect, type APIRequestContext } from '@playwright/test';

import { bypassRateLimitHeaders } from '../../_helpers';

import { MEGA_RUN_STAMP } from './run-stamp';

export const MEGA_STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

/**
 * Garde-fou anti-fuite prod. Throw si l'URL cible n'est pas du staging.
 * Appelé au démarrage de chaque helper qui pose des mutations.
 */
function assertStagingUrl(url: string): void {
  // Patterns autorisés :
  //   - https://hub.staging.veridian.site
  //   - https://*.staging.veridian.site (cas spéciaux multi-tenants)
  //   - http://localhost:3000 (dev local)
  //   - http://127.0.0.1:3000
  const allowed = /^(https?:\/\/)?(localhost|127\.0\.0\.1|.+\.staging\.veridian\.site)(:|\/|$)/i;
  if (!allowed.test(url)) {
    throw new Error(
      `[mega/mock-oauth] URL '${url}' n'est pas du staging — REFUS d'exécuter mock-oauth.\n` +
        `URLs autorisées : *.staging.veridian.site, localhost, 127.0.0.1.\n` +
        `Triple garde-fou contre une fuite prod accidentelle.`,
    );
  }
}

export type MockProvider = 'google' | 'microsoft-entra-id';

export interface MegaSignInOpts {
  /** Bucket de la suite (A, B, C, …). Sert au préfixe email pour cleanup. */
  bucket: string;
  /** Slug spec (ex: `01-signup-oauth-google`). Sert au préfixe email. */
  spec: string;
  /** Provider OAuth mocké. Défaut `google`. */
  provider?: MockProvider;
  /** Email `email_verified` côté provider mock. Défaut `true`. */
  emailVerified?: boolean;
  /** Override email (pour tests d'idempotence signup 2× même email). */
  emailOverride?: string;
  /** Variant pour différencier 2 signins dans le même spec. */
  variant?: string;
}

export interface MegaSession {
  /** Email utilisé pour le signup (à utiliser dans les asserts DB). */
  email: string;
  /** Context Playwright porteur des cookies de session Auth.js. */
  request: APIRequestContext;
  /** Provider OAuth utilisé. */
  provider: MockProvider;
  /** Status de la réponse callback (200/302 = succès). */
  callbackStatus: number;
}

/**
 * Génère un email unique formaté pour la suite MEGA.
 * Format strict : `e2e-mega-<bucket>-<spec>[-<variant>]-<RUN_STAMP>@e2e.veridian.site`.
 *
 * Le préfixe `e2e-mega-` permet au cleanup global de filtrer sans risque
 * de collision avec des emails réels.
 */
export function megaEmail(opts: { bucket: string; spec: string; variant?: string }): string {
  const variant = opts.variant ? `-${opts.variant}` : '';
  // Sanitize bucket/spec : lowercase, alphanumeric + dash uniquement
  const cleanBucket = opts.bucket.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanSpec = opts.spec.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `e2e-mega-${cleanBucket}-${cleanSpec}${variant}-${MEGA_RUN_STAMP}@e2e.veridian.site`;
}

/**
 * Génère un tenantId unique formaté pour la suite MEGA.
 * Format strict : `mega-<bucket>-<RUN_STAMP>-<slug>`.
 */
export function megaTenantId(opts: { bucket: string; slug: string }): string {
  const cleanBucket = opts.bucket.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanSlug = opts.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `mega-${cleanBucket}-${MEGA_RUN_STAMP}-${cleanSlug}`;
}

/**
 * Récupère un CSRF token Auth.js v5. Requis pour POST /api/auth/callback/*.
 */
async function getCsrfToken(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${MEGA_STAGING_URL}/api/auth/csrf`);
  expect(res.status(), 'CSRF endpoint must return 200').toBe(200);
  const body = await res.json();
  expect(typeof body.csrfToken).toBe('string');
  return body.csrfToken;
}

/**
 * Vérifie que le provider `mock-oauth` est listé dans /api/auth/providers.
 * À appeler en début de spec qui dépend du mock provider.
 *
 * Si absent → throw avec message clair (compose staging mal configuré).
 */
export async function assertMockOAuthAvailable(request: APIRequestContext): Promise<void> {
  assertStagingUrl(MEGA_STAGING_URL);
  const res = await request.get(`${MEGA_STAGING_URL}/api/auth/providers`);
  expect(res.status(), 'GET /api/auth/providers must return 200').toBe(200);
  const body = await res.json();
  expect(
    body,
    `mock-oauth provider absent — vérifie OAUTH_TEST_PROVIDER=true côté compose ${MEGA_STAGING_URL}`,
  ).toHaveProperty('mock-oauth');
}

/**
 * Joue un signup/login OAuth mocké et retourne un session porteur des
 * cookies de session pour réutilisation dans les assertions DB/dashboard.
 *
 * Si `emailOverride` n'est pas fourni, génère un email unique via `megaEmail()`.
 *
 * Le APIRequestContext retourné est cookie-aware : tous les calls suivants
 * (`session.request.get('/dashboard')`) hériteront du cookie Auth.js.
 *
 * **Important** : le caller est responsable de `session.request.dispose()`
 * en `test.afterEach` (sinon fuite de contexte Playwright).
 */
export async function megaSignIn(
  playwright: typeof import('@playwright/test'),
  opts: MegaSignInOpts,
): Promise<MegaSession> {
  assertStagingUrl(MEGA_STAGING_URL);

  const provider = opts.provider ?? 'google';
  const email = opts.emailOverride ?? megaEmail(opts);

  const request = await playwright.request.newContext({
    baseURL: MEGA_STAGING_URL,
  });

  const csrf = await getCsrfToken(request);

  const cb = await request.post('/api/auth/callback/mock-oauth', {
    // Bypass oauthCallbackLimiter (30/min/IP) — la suite MEGA enchaîne 80+
    // signins sur la même IP Traefik. Sans bypass, on tape 429 dès le 31e.
    headers: bypassRateLimitHeaders(),
    form: {
      csrfToken: csrf,
      email,
      mockProvider: provider,
      mockEmailVerified: opts.emailVerified === false ? 'false' : 'true',
      callbackUrl: `${MEGA_STAGING_URL}/dashboard`,
      json: 'true',
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });

  const callbackStatus = cb.status();
  expect(
    callbackStatus,
    `[mega/mock-oauth] mock-oauth callback for ${email} (provider=${provider}) doit 200/302, got ${callbackStatus}`,
  ).toBeLessThan(400);

  return {
    email,
    request,
    provider,
    callbackStatus,
  };
}

/**
 * Helper de cleanup pour fermer proprement une session MegaSession.
 * À appeler en `test.afterEach` :
 *
 *   test.afterEach(async () => {
 *     if (session) await disposeSession(session);
 *   });
 *
 * Try/catch interne : ne throw jamais (Playwright ne bypass-pas les
 * afterEach si une exception remonte, mais on évite quand même les
 * surprises sur des contextes déjà fermés).
 */
export async function disposeSession(session: MegaSession | null | undefined): Promise<void> {
  if (!session) return;
  try {
    await session.request.dispose();
  } catch {
    /* déjà fermé, no-op */
  }
}
