/**
 * Vérification HMAC pour les appels APP DOWNSTREAM → HUB sur le scope
 * invitations (`POST /api/invitations/create`).
 *
 * Pattern : même que `app/api/webhooks/notifuse/route.ts` :
 *   - Header `x-veridian-timestamp` (ms epoch)
 *   - Header `x-veridian-invitation-signature` (hex sha256(timestamp + '.' + rawBody))
 *   - Header `x-veridian-app` (identifie l'app appelante → choix du secret)
 *   - Drift max 5 min (anti-replay simple, suffisant pour un canal HMAC
 *     entre apps sur le même réseau)
 *
 * Chaque app downstream a son propre secret en ENV :
 *   - HUB_INVITATION_SECRET_NOTIFUSE
 *   - HUB_INVITATION_SECRET_PROSPECTION
 *   - HUB_INVITATION_SECRET_ANALYTICS
 *   - HUB_INVITATION_SECRET_CMS
 *
 * Permet de révoquer/rotater un secret app-par-app sans impacter les autres.
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
 * Résout le secret HMAC à partir du nom d'app. Renvoie null si pas configuré
 * (ENV manquante → 503 côté caller, pas une 401 silencieuse qui masque un
 * problème de déploiement).
 */
export function resolveInvitationSecret(
  app: SupportedApp,
  envOverride?: NodeJS.ProcessEnv,
): string | null {
  const env = envOverride ?? process.env;
  const key = `HUB_INVITATION_SECRET_${app.toUpperCase()}`;
  const raw = env[key];
  if (!raw || raw.trim().length === 0) return null;
  return raw;
}

export type VerifyResult =
  | { ok: true; app: SupportedApp }
  | { ok: false; reason: string; status: 400 | 401 | 503 };

/**
 * Vérifie une requête entrante d'app downstream.
 * Renvoie ok+app si valide, sinon reason+status code suggéré.
 *
 * Le caller doit re-fournir `rawBody` (string original, pas le JSON.parse) car
 * la signature HMAC est calculée sur les bytes exacts du body.
 */
export function verifyInvitationHmac(
  headers: Headers,
  rawBody: string,
  options: {
    envOverride?: NodeJS.ProcessEnv;
    nowMs?: number;
  } = {},
): VerifyResult {
  const appHeader = headers.get('x-veridian-app');
  const timestamp = headers.get('x-veridian-timestamp');
  const signature = headers.get('x-veridian-invitation-signature');

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
      reason: 'missing x-veridian-timestamp or x-veridian-invitation-signature',
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

  const secret = resolveInvitationSecret(appHeader, options.envOverride);
  if (!secret) {
    return {
      ok: false,
      reason: `HUB_INVITATION_SECRET_${appHeader.toUpperCase()} not configured`,
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
