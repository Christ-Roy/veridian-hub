/**
 * Helpers partagés pour les specs `e2e/staging-full/*`.
 *
 * **Pourquoi** : la suite enchaîne 60+ tests sur la même IP côté staging,
 * et plusieurs rate-limiters Hub sont vite tapés :
 *   - signupLimiter : 5 req/min/IP
 *   - adminApiLimiter : 30 req/min/IP
 *   - invitationCreateLimiter : 60 req/min/IP
 *
 * Traefik réécrit `x-forwarded-for` (sécu : on ne peut pas spoof son IP
 * depuis Internet), donc le bypass par rotation IP ne marche pas tel quel.
 * La stratégie en place (2026-05-23, ticket cascade rate-limit) :
 *   1. **Bypass header secret pour l'admin API** (staging-only) :
 *      `adminHeaders()` pose `x-veridian-e2e-bypass-ratelimit` avec le
 *      secret `E2E_RATELIMIT_BYPASS_SECRET`. Côté Hub `authenticateAdmin`
 *      skip le rate-limit quand ce header est valide ET `DEPLOY_ENV !== 'prod'`.
 *      → coupe la cascade 429 sur 5 specs (13, 05, 15, 07, 11) à la source.
 *   2. On garde aussi un header `x-forwarded-for` informatif (utile en
 *      local-dev sans Traefik / sur les autres rate-limiters non-admin).
 *   3. Fallback : si 429 quand même (limiter non-admin ou bypass non-configuré),
 *      `withRateLimitRetry()` lit `Retry-After` et retry — standard industriel.
 *
 * Usage :
 *   import { withRateLimitRetry, adminHeaders, RUN_STAMP } from './_helpers';
 *   const res = await withRateLimitRetry(() => request.post(...));
 */

export const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

export const ADMIN_SECRET =
  process.env.HUB_ADMIN_SECRET || 'staging-admin-secret-not-real-e2e';

/**
 * Secret bypass rate-limit admin pour les E2E staging.
 * Lu depuis `E2E_RATELIMIT_BYPASS_SECRET` (auto-sourcé par
 * `scripts/e2e/staging-full.sh` depuis `~/credentials/.all-creds.env`).
 *
 * Si absent → on n'ajoute pas le header, et la suite retombe sur le
 * fallback `withRateLimitRetry` (lent mais fonctionnel). Ne pas throw —
 * on veut que la suite tourne quand même en mode dégradé en local.
 */
export const E2E_RATELIMIT_BYPASS_SECRET =
  process.env.E2E_RATELIMIT_BYPASS_SECRET || '';

export const RUN_STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

let counter = 0;

export function freshIpHeader(): Record<string, string> {
  counter++;
  return {
    'x-forwarded-for': `10.99.${(counter >> 8) & 0xff}.${counter & 0xff}`,
  };
}

/**
 * Pose le header de bypass rate-limit si le secret est configuré.
 * No-op sinon (mode dégradé : on retombera sur withRateLimitRetry).
 *
 * Alias `bypassRateLimitHeaders()` exposé pour symétrie avec
 * `adminHeaders()` / `signupHeaders()` — même implémentation.
 */
export function rateLimitBypassHeader(): Record<string, string> {
  if (!E2E_RATELIMIT_BYPASS_SECRET) return {};
  return { 'x-veridian-e2e-bypass-ratelimit': E2E_RATELIMIT_BYPASS_SECRET };
}

export const bypassRateLimitHeaders = rateLimitBypassHeader;

export function adminHeaders(): Record<string, string> {
  return {
    'x-admin-secret': ADMIN_SECRET,
    ...freshIpHeader(),
    ...rateLimitBypassHeader(),
  };
}

/**
 * Headers pour POST /api/auth/signup en E2E :
 *  - IP fraîche (héritage avant bypass, garde une isolation per-call)
 *  - header bypass rate-limit (skip signupLimiter 5/min/IP côté Hub)
 *
 * Sans le bypass, la suite tape 429 dès le 6e signup sur la même IP
 * Traefik. Avec le bypass on enchaîne 60+ signups sans cap.
 */
export function signupHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...freshIpHeader(),
    ...rateLimitBypassHeader(),
  };
}

/**
 * Headers pour POST /api/auth/callback/credentials (login Auth.js).
 *  - bypass credentialsLoginLimiter 5/min/IP côté Hub
 *
 * Utile en spec 03 et toutes celles qui font un login credentials avant
 * un parcours session-aware.
 */
export function credentialsLoginHeaders(): Record<string, string> {
  return {
    ...freshIpHeader(),
    ...rateLimitBypassHeader(),
  };
}

/**
 * Headers pour POST /api/invitations/create (HMAC + bypass).
 * À mixer avec les headers HMAC signés calculés par le caller.
 */
export function invitationCreateHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...freshIpHeader(),
    ...rateLimitBypassHeader(),
  };
}

export function uniqueEmail(slug: string, prefix = 'e2e'): string {
  return `${prefix}-${slug}-${RUN_STAMP}@e2e.veridian.site`;
}

/**
 * Wrap une requête pour gérer les 429 rate-limit du Hub.
 * Si la réponse a status === 429, on lit `Retry-After`, on attend,
 * et on retry jusqu'à `maxRetries` fois (défaut 2).
 *
 * Compatible avec `APIResponse` Playwright (.status() méthode) et
 * Response natif (.status getter, .headers Headers).
 */
type AnyResponse = unknown;

function readStatus(res: any): number {
  return typeof res.status === 'function' ? res.status() : res.status;
}

function readRetryAfter(res: any): string | null {
  // Playwright APIResponse : .headers() retourne Record<string,string>
  if (typeof res.headers === 'function') {
    try {
      const h = res.headers();
      return h['retry-after'] ?? h['Retry-After'] ?? null;
    } catch {
      return null;
    }
  }
  // fetch Response : .headers est un Headers
  if (res.headers && typeof res.headers.get === 'function') {
    return res.headers.get('retry-after');
  }
  return null;
}

export async function withRateLimitRetry<T extends AnyResponse>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; defaultDelayMs?: number } = {},
): Promise<T> {
  // Traefik staging réécrit x-forwarded-for avec sa propre IP — le bypass
  // `freshIpHeader()` ne marche pas en réalité. Tous les calls partent
  // d'1 seule IP côté Hub → on partage le bucket 30/min/IP de l'admin API
  // sur toute la suite (60+ tests). Il faut être patient sinon un test
  // perd silencieusement son setup (user.create → 429 → linkApp → 404
  // user_not_found, exactement le mode de défaillance vu sur S6 2026-05-23).
  //
  // 5 retries × jusqu'à 60s = ~5 min de patience max par appel. Suffisant
  // pour traverser une fenêtre 30/min même quand tous les tests poussent.
  const maxRetries = opts.maxRetries ?? 5;
  const defaultDelay = opts.defaultDelayMs ?? 6_000;
  let last: T | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fn();
    last = res;
    const status = readStatus(res);
    if (status !== 429) return res;
    if (attempt === maxRetries) return res;
    let delayMs = defaultDelay;
    const retryAfter = readRetryAfter(res);
    if (retryAfter) {
      const secs = Number(retryAfter);
      // Borne haute portée à 65s pour absorber une fenêtre 30/min/IP
      // complète sans casser un test ; en-dessous on lit ce que dit le serveur.
      if (Number.isFinite(secs) && secs > 0 && secs < 65) {
        delayMs = secs * 1000 + 500;
      } else if (Number.isFinite(secs) && secs >= 65) {
        delayMs = 65_000;
      }
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[e2e] rate-limit 429 (attempt ${attempt + 1}/${maxRetries + 1}), sleeping ${delayMs}ms before retry`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last!;
}

/**
 * Wrapper spécialisé pour les calls de SETUP (create user, link tenant)
 * dont l'échec silencieux casse la suite en cascade. Force une assertion
 * stricte sur le status code attendu (souvent 200), et accepte une liste
 * d'autres status valides (ex: 200 || already_existed=true via body).
 *
 * Si on tape 429 après tous les retries de `withRateLimitRetry`, on **throw**
 * plutôt que de laisser le test suivant courir dans le vide. C'est l'inverse
 * du fail-open : on préfère un échec explicite "rate-limited après 5 retries"
 * à un 404 user_not_found 30 secondes plus tard.
 */
export async function setupCall<T extends { status: () => number }>(
  fn: () => Promise<T>,
  opts: { expectedStatus?: number[]; label: string } = { label: 'setup' },
): Promise<T> {
  const expected = opts.expectedStatus ?? [200];
  const res = await withRateLimitRetry(fn);
  const status = readStatus(res);
  if (!expected.includes(status)) {
    throw new Error(
      `[e2e setup "${opts.label}"] expected status in [${expected.join(',')}], got ${status}. ` +
        `Soit le rate-limit a explosé (429 persistant après 5 retries), soit le serveur est down.`,
    );
  }
  return res;
}
