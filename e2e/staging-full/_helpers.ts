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
 * depuis Internet), donc le bypass par header ne marche pas tel quel.
 * La stratégie en place :
 *   1. On gardé un header `x-forwarded-for` "informatif" (utile en local-dev
 *      sans Traefik).
 *   2. Quand on tape 429, on read `Retry-After`, on `sleep`, puis on retry —
 *      cf. `withRateLimitRetry()` ci-dessous. Standard industriel pour
 *      consommer une API avec rate-limit.
 *
 * Usage :
 *   import { withRateLimitRetry, adminHeaders, RUN_STAMP } from './_helpers';
 *   const res = await withRateLimitRetry(() => request.post(...));
 */

export const STAGING_URL =
  process.env.STAGING_URL || 'https://hub.staging.veridian.site';

export const ADMIN_SECRET =
  process.env.HUB_ADMIN_SECRET || 'staging-admin-secret-not-real-e2e';

export const RUN_STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

let counter = 0;

export function freshIpHeader(): Record<string, string> {
  counter++;
  return {
    'x-forwarded-for': `10.99.${(counter >> 8) & 0xff}.${counter & 0xff}`,
  };
}

export function adminHeaders(): Record<string, string> {
  return {
    'x-admin-secret': ADMIN_SECRET,
    ...freshIpHeader(),
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
  const maxRetries = opts.maxRetries ?? 2;
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
      if (Number.isFinite(secs) && secs > 0 && secs < 120) {
        delayMs = secs * 1000 + 500;
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
