/**
 * Vérification HMAC pour les appels APP DOWNSTREAM → HUB sur le scope
 * billing-state (`GET /api/tenants/{tenantId}/billing-state`).
 *
 * Pattern : Pattern A — `CONTRAT-HUB.md` §6.1.
 *   - Header `X-Veridian-Timestamp` (ms epoch)
 *   - Header `X-Veridian-Hub-Signature` (hex sha256(timestamp + '.' + rawBody))
 *   - Header `x-veridian-app` (identifie l'app appelante → choix du secret)
 *   - Drift max 5 min (anti-replay)
 *
 * Pour un GET, `rawBody` est la string vide `""` — c'est le shape attendu
 * par l'app cliente qui signe `${timestamp}.""`. Aucun body n'est lu côté
 * route. On reste cohérent avec le pattern partagé Pattern A.
 *
 * Secret par app : `<APP>_HUB_API_SECRET` (canonique §6.1, déjà câblé pour
 * `NOTIFUSE_HUB_API_SECRET` et `PROSPECTION_HUB_API_SECRET`). On RÉUTILISE
 * ce secret — pas de nouveau secret par scope. Rotation 6 mois unique pour
 * tous les flows Hub↔app.
 *
 * NB : ce module est distinct de `lib/invitations/hmac.ts` qui utilise un
 * secret dédié `HUB_INVITATION_SECRET_<APP>` (héritage v1.4 — invitations
 * livrées avec leur propre secret avant la convergence sur `<APP>_HUB_API_SECRET`).
 * Pour billing-state, on aligne directement sur le canonique §6.1.
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
 * Résout le secret HMAC canonique `<APP>_HUB_API_SECRET`.
 *
 * Renvoie null si la variable n'est pas configurée → la route doit répondre
 * 503 et logger, pas une 401 silencieuse qui masquerait un problème de
 * déploiement.
 */
export function resolveBillingStateSecret(
  app: SupportedApp,
  envOverride?: NodeJS.ProcessEnv,
): string | null {
  const env = envOverride ?? process.env;
  const key = `${app.toUpperCase()}_HUB_API_SECRET`;
  const raw = env[key];
  if (!raw || raw.trim().length === 0) return null;
  return raw;
}

export type VerifyResult =
  | { ok: true; app: SupportedApp }
  | { ok: false; reason: string; status: 400 | 401 | 503 };

/**
 * Vérifie une requête entrante d'app downstream sur le scope billing-state.
 *
 * Le caller passe `rawBody` pour rester compatible Pattern A. Pour un GET,
 * `rawBody` doit être `""` (le payload signé est `timestamp + "." + ""`).
 */
export function verifyBillingStateHmac(
  headers: Headers,
  rawBody: string,
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

  const secret = resolveBillingStateSecret(appHeader, options.envOverride);
  if (!secret) {
    return {
      ok: false,
      reason: `${appHeader.toUpperCase()}_HUB_API_SECRET not configured`,
      status: 503,
    };
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

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
