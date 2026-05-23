/**
 * Vérification HMAC pour `GET /api/users/by-email` — Discovery cross-app.
 *
 * Sens du flux : **app downstream → Hub** (l'app interroge le Hub au login
 * pour savoir si un email est déjà connu et router vers les apps actives).
 * Inversion volontaire du flux historique Hub→app : on réutilise tout de
 * même la **même paire de secrets** `<APP>_HUB_API_SECRET` (Hub) /
 * `HUB_API_SECRET` (app) gravée §6.1 / §6.5 de `docs/CONTRAT-HUB.md`. Un
 * secret HMAC est symétrique : ne pas multiplier les secrets pour la même
 * paire de partenaires.
 *
 * Pas de body sur un GET → la signature couvre `${timestamp}.${method}.
 * ${path_with_query}` (pattern OWASP §"HMAC Signing for GET requests").
 *   - `method` : "GET" en majuscule pour stabilité cross-impl.
 *   - `path_with_query` : pathname + "?" + searchParams triés
 *     alphabétiquement (anti-malléabilité de l'ordre des params).
 *
 * Headers attendus :
 *   - `x-veridian-app`        : nom de l'app caller (notifuse|prospection|analytics|cms)
 *   - `x-veridian-timestamp`  : unix ms epoch, drift max 5 min (anti-replay)
 *   - `x-veridian-hub-signature` : hex sha256 de la string canonique
 *
 * Drift, encodage, comparaison constant-time : strictement aligné sur
 * `lib/invitations/hmac.ts` qui sert de prior art éprouvé en prod.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_DRIFT_MS = 5 * 60 * 1000;

export const SUPPORTED_APPS = [
  'notifuse',
  'prospection',
  'analytics',
  'cms',
] as const;
export type SupportedApp = (typeof SUPPORTED_APPS)[number];

export function isSupportedApp(app: string): app is SupportedApp {
  return (SUPPORTED_APPS as readonly string[]).includes(app);
}

/**
 * Résout le secret HMAC à partir du nom d'app.
 *
 * Source : ENV `<APP>_HUB_API_SECRET` (convention contrat §6.5). Les
 * mêmes secrets que ceux utilisés par le Hub pour signer les appels
 * sortants Hub → app sont réutilisés dans le sens inverse — un secret
 * HMAC est symétrique, dédoubler serait du bruit pour aucun gain de
 * sécurité.
 *
 * Renvoie null si la variable est manquante ou vide : on remonte ça en
 * 503 côté caller (pas 401 silencieuse) — un 503 attire l'attention sur
 * un problème de déploiement plutôt qu'on suspecte un bug client.
 */
export function resolveHubApiSecret(
  app: SupportedApp,
  envOverride?: NodeJS.ProcessEnv,
): string | null {
  const env = envOverride ?? process.env;
  const key = `${app.toUpperCase()}_HUB_API_SECRET`;
  const raw = env[key];
  if (!raw || raw.trim().length === 0) return null;
  return raw;
}

/**
 * Reconstruit la string canonique signée pour un GET.
 *
 * Format : `${timestamp}.${METHOD}.${pathname}?${sortedQuery}`
 *
 * Trier les query params est indispensable : sans ça, un proxy qui
 * réordonne (`?email=x&trace=1` vs `?trace=1&email=x`) ferait échouer
 * la vérification HMAC alors que la requête est sémantiquement identique.
 * On normalise pour fiabilité opérationnelle.
 *
 * Si plusieurs valeurs pour la même clé (cas multi-value query), on
 * conserve l'ordre d'apparition d'origine pour cette clé (sort stable).
 */
export function buildCanonicalGetString(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  timestamp: string,
): string {
  const entries: Array<[string, string]> = [];
  searchParams.forEach((value, key) => {
    entries.push([key, value]);
  });
  // Tri stable par clé (puis ordre d'apparition pour multi-value).
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const sortedQs = entries
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
  const path = sortedQs.length > 0 ? `${pathname}?${sortedQs}` : pathname;
  return `${timestamp}.${method.toUpperCase()}.${path}`;
}

export type VerifyResult =
  | { ok: true; app: SupportedApp }
  | { ok: false; reason: string; status: 400 | 401 | 503 };

/**
 * Vérifie une requête GET entrante d'app downstream (header HMAC).
 *
 * - 400 si headers manquants ou app inconnue
 * - 401 si timestamp drift trop large ou signature invalide
 * - 503 si secret pas configuré côté Hub (problème de déploiement)
 *
 * Le caller doit fournir `url` (URL parsée du request) et `method` pour
 * que la canonical string corresponde à celle calculée côté caller.
 */
export function verifyDiscoveryHmac(
  headers: Headers,
  method: string,
  url: URL,
  options: {
    envOverride?: NodeJS.ProcessEnv;
    nowMs?: number;
  } = {},
): VerifyResult {
  const appHeader = headers.get('x-veridian-app');
  const timestamp = headers.get('x-veridian-timestamp');
  const signature = headers.get('x-veridian-hub-signature');

  if (!appHeader) {
    return { ok: false, reason: 'missing x-veridian-app header', status: 400 };
  }
  if (!isSupportedApp(appHeader)) {
    return {
      ok: false,
      reason: `unsupported app: ${appHeader}`,
      status: 400,
    };
  }
  if (!timestamp || !signature) {
    return {
      ok: false,
      reason: 'missing x-veridian-timestamp or x-veridian-hub-signature',
      status: 400,
    };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid timestamp', status: 400 };
  }
  const now = options.nowMs ?? Date.now();
  if (Math.abs(now - ts) > MAX_DRIFT_MS) {
    return {
      ok: false,
      reason: `timestamp drift > ${MAX_DRIFT_MS / 1000}s`,
      status: 401,
    };
  }

  const secret = resolveHubApiSecret(appHeader, options.envOverride);
  if (!secret) {
    return {
      ok: false,
      reason: `${appHeader.toUpperCase()}_HUB_API_SECRET not configured`,
      status: 503,
    };
  }

  const canonical = buildCanonicalGetString(
    method,
    url.pathname,
    url.searchParams,
    timestamp,
  );

  const expected = createHmac('sha256', secret).update(canonical).digest('hex');

  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) {
      return { ok: false, reason: 'invalid signature', status: 401 };
    }
    if (!timingSafeEqual(a, b)) {
      return { ok: false, reason: 'invalid signature', status: 401 };
    }
  } catch {
    return { ok: false, reason: 'invalid signature encoding', status: 401 };
  }

  return { ok: true, app: appHeader };
}
