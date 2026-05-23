/**
 * Couche 4 — Bounce OAuth Hub (cf. CONTRAT-HUB §6bis.8).
 *
 * Helpers pour parser, valider et persister le paramètre `?next=` qui permet
 * à une app downstream de déléguer le flow OAuth au Hub puis de récupérer
 * l'user loggué sur elle-même via un magic link Hub→app.
 *
 * Sécurité critique :
 *
 *  1. **Whitelist regex stricte** (anti open-redirect). Seul un host
 *     `<sub>.veridian.site` (et `<sub>.staging.veridian.site` en staging) est
 *     accepté. Toute autre URL = ignorée silencieusement + log warning.
 *     Le pattern est intentionnellement large : toute future app
 *     `*.veridian.site` est éligible sans modif Hub (cf. §6bis.8.6).
 *
 *  2. **Cookie signé HMAC** (`__Secure-veridian-next`). Le `next` est persisté
 *     dans un cookie httpOnly + sameSite=Lax + Secure (en prod) signé avec
 *     `AUTH_SECRET` (réutilisé, pas de nouveau secret). Le timestamp est
 *     embarqué pour invalider toute injection > TTL.
 *
 *  3. **Pas de Referer fuite** : on n'injecte JAMAIS `next` dans l'URL OAuth
 *     publique. Le cookie est posé AVANT le redirect provider, lu APRÈS le
 *     callback OAuth.
 *
 *  4. **App self-bounce refusée** : `app.veridian.site` (et `hub.staging.veridian.site`)
 *     ne sont pas des cibles valides — bouncer vers le Hub depuis le Hub
 *     n'a pas de sens et créerait potentiellement une boucle.
 *
 * Référence : `docs/CONTRAT-HUB.md` §6bis.8.2.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Nom du cookie côté production (préfixe `__Secure-` exige HTTPS).
 *
 * En local dev (HTTP), on retombe sur `veridian-next` sans préfixe.
 */
export const NEXT_COOKIE_NAME_SECURE = '__Secure-veridian-next';
export const NEXT_COOKIE_NAME_INSECURE = 'veridian-next';

/** TTL du cookie next : 10 minutes (couvre le flow OAuth complet). */
export const NEXT_COOKIE_TTL_MS = 10 * 60 * 1000;

/** Regex whitelist côté production : `https://<sub>.veridian.site` + sous-paths. */
const NEXT_WHITELIST_REGEX_PROD = /^https:\/\/[a-z0-9-]+\.veridian\.site(\/.*)?$/;

/** Regex whitelist côté staging : `https://<sub>.staging.veridian.site` + sous-paths. */
const NEXT_WHITELIST_REGEX_STAGING = /^https:\/\/[a-z0-9-]+\.staging\.veridian\.site(\/.*)?$/;

/**
 * Sous-domaines Hub à refuser (anti-boucle Hub→Hub).
 * Si l'app cible EST le Hub lui-même, on retombe sur le flow normal /dashboard.
 */
const HUB_SUBDOMAINS = new Set(['app', 'hub']);

/**
 * Résultat d'une validation `next` : URL nettoyée + nom d'app extrait
 * (sous-domaine sans le `.veridian.site` ou `.staging.veridian.site`).
 */
export interface ParsedNext {
  /** URL nettoyée (telle que reçue, validée whitelist). */
  url: string;
  /** Sous-domaine extrait : `notifuse`, `prospection`, `cms`, `analytics`, ... */
  app: string;
  /** Host complet (sans schéma). */
  host: string;
}

export type DeployEnv = 'production' | 'staging' | 'development' | 'test' | string;

/**
 * Choisit la regex whitelist selon `DEPLOY_ENV`.
 *
 * - production → `*.veridian.site`
 * - staging    → `*.staging.veridian.site`
 * - autres (dev/test) → accepte les deux (utile pour tests unitaires + dev local
 *   qui pointerait sur staging)
 */
export function whitelistRegexFor(deployEnv: DeployEnv | undefined): RegExp[] {
  if (deployEnv === 'production') return [NEXT_WHITELIST_REGEX_PROD];
  if (deployEnv === 'staging') return [NEXT_WHITELIST_REGEX_STAGING];
  // dev / test : on accepte les deux pour ne pas bloquer les tests
  return [NEXT_WHITELIST_REGEX_PROD, NEXT_WHITELIST_REGEX_STAGING];
}

/**
 * Valide `next` contre la whitelist regex et extrait le sous-domaine app.
 *
 * Retourne `null` si :
 *  - URL absente / vide / non-string
 *  - URL ne matche aucune regex whitelist active pour l'env
 *  - URL pointe sur un sous-domaine Hub (app.* ou hub.*) — pas de bounce vers
 *    Hub depuis Hub
 *
 * Aucune exception levée : on ignore silencieusement (cf. spec 6bis.8.2 point 5).
 */
export function parseNext(
  next: string | null | undefined,
  deployEnv: DeployEnv | undefined,
): ParsedNext | null {
  if (!next || typeof next !== 'string') return null;

  // Garde-fou : refuse les URLs trop longues (anti-DoS, anti-injection cookies).
  if (next.length > 2048) return null;

  const regexes = whitelistRegexFor(deployEnv);
  const matched = regexes.some((r) => r.test(next));
  if (!matched) return null;

  // Extrait host + sous-domaine via URL parser (next a déjà passé la regex,
  // donc structure garantie valide).
  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;

  const host = parsed.host.toLowerCase();
  // Extraction du sous-domaine : le premier label avant `.veridian.site`
  // ou `.staging.veridian.site`.
  const subdomain = extractSubdomain(host);
  if (!subdomain) return null;

  // Refuser les sous-domaines Hub (anti-boucle, pas de bounce vers soi-même).
  if (HUB_SUBDOMAINS.has(subdomain)) return null;

  return { url: next, app: subdomain, host };
}

/**
 * Extrait le sous-domaine app : pour `notifuse.veridian.site` → `notifuse`,
 * pour `prospection.staging.veridian.site` → `prospection`.
 */
function extractSubdomain(host: string): string | null {
  // Strip port if any (URL.host inclut le port).
  const hostNoPort = host.split(':')[0];
  const parts = hostNoPort.split('.');
  // Prod : <sub>.veridian.site → 3 parts, sub = parts[0]
  // Staging : <sub>.staging.veridian.site → 4 parts, sub = parts[0]
  if (parts.length < 3) return null;
  const sub = parts[0];
  if (!/^[a-z0-9-]+$/.test(sub)) return null;
  return sub;
}

/**
 * Sérialise + signe le payload `next` pour le cookie.
 *
 * Format payload : `<expiresAtMs>.<base64url(next)>.<hex(hmac)>`
 *
 * Le HMAC couvre `<expiresAtMs>.<base64url(next)>` avec `AUTH_SECRET`.
 * Pas de dépendance Auth.js : on reste minimaliste, pas de JWE/JWT lourd.
 */
export function signNextCookie(
  next: string,
  secret: string,
  nowMs: number = Date.now(),
): string {
  if (!secret) throw new Error('signNextCookie: secret is required');
  const expiresAtMs = nowMs + NEXT_COOKIE_TTL_MS;
  const payload = `${expiresAtMs}.${toBase64Url(next)}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Vérifie + déserialise le cookie. Retourne `null` si :
 *  - format invalide
 *  - signature HMAC mismatch
 *  - cookie expiré
 *
 * Aucune exception : le caller traite tout `null` comme "next non récupérable".
 */
export function verifyNextCookie(
  cookieValue: string | null | undefined,
  secret: string,
  nowMs: number = Date.now(),
): string | null {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [expiresStr, b64, sig] = parts;

  const expectedSig = createHmac('sha256', secret)
    .update(`${expiresStr}.${b64}`)
    .digest('hex');

  // Comparaison timing-safe — protège contre le timing attack sur signature.
  if (!constantTimeStringEqual(sig, expectedSig)) return null;

  const expiresAtMs = Number(expiresStr);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;

  let next: string;
  try {
    next = fromBase64Url(b64);
  } catch {
    return null;
  }
  return next;
}

/**
 * Choisit le nom du cookie selon le scheme effectif (HTTPS → préfixe sécurisé).
 *
 * Logique alignée sur `lib/auth/impersonation.ts:secureCookiesEnabled()`.
 */
export function nextCookieName(secure: boolean): string {
  return secure ? NEXT_COOKIE_NAME_SECURE : NEXT_COOKIE_NAME_INSECURE;
}

/**
 * Décide si on doit utiliser les cookies sécurisés (préfixe `__Secure-`).
 * Aligné sur `impersonation.ts:secureCookiesEnabled` pour cohérence.
 */
export function shouldUseSecureCookie(): boolean {
  const url = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_SITE_URL || '';
  if (!url) return false;
  return !url.startsWith('http://');
}

// ---- internals ----

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  // Restaure le padding base64 standard.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
