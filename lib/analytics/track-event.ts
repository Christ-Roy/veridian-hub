/**
 * Émission server-to-server d'un goal vers Veridian Analytics (tunnel de vente).
 *
 * CONTEXTE — pourquoi ce module existe
 * Le Hub ne traçait jusqu'ici AUCUN event produit vers Veridian Analytics
 * (seul GA4/GTM client-side). Pour le tunnel de vente outbound, on veut savoir
 * côté CRM si un prospect — déjà identifié par son email — s'inscrit
 * (`signup`) puis démarre une app (`app_started`). Le bridge réconciliateur
 * fait l'union slug↔email EN AVAL (contrat tunnel §4a) : ici on émet
 * simplement `user_id = email normalisé`, rien d'autre.
 *
 * GARANTIE — best-effort STRICT (fire-and-forget)
 * Un échec analytics ne doit JAMAIS casser un signup ou une provision. Toute
 * erreur (réseau, timeout, 4xx/5xx, config absente) est avalée et loggée en
 * `warn`. AUCUN retry bloquant, AUCun throw qui remonte à l'appelant. Les call
 * sites font `void trackGoal(...)` sans await — le flow métier n'attend pas.
 *
 * CIBLE — Rybbit (Analytics G3), `POST /api/track`, depuis le 08/11. Le Hub visait encore le moteur G2,
 * arrêté (404) : aucun objectif n'arrivait. Événement `custom_event` sur le site veridian.site (id 2),
 * `user_id` = adresse normalisée (identification Rybbit), `properties` en chaîne JSON. En-têtes de
 * navigateur obligatoires : sans eux Rybbit classe l'appel en robot et le jette en silence (mesuré le
 * 17/08 par la session Rybbit). Hors prod, rien ne part sans site explicite : jamais de pollution du prod.
 *
 * Server-only par convention (comme `lib/notifuse/client.ts` et
 * `lib/analytics/client.ts`) : lit des ENV runtime, à n'importer QUE depuis du
 * code serveur (routes API, events Auth.js). Jamais depuis un composant client.
 */

import { isIP } from 'node:net';

import { extractClientIp } from '@/lib/auth/rate-limit';

/** Site Rybbit du tunnel : veridian.site. Surchargé par `ANALYTICS_TRACK_SITE_ID`. */
const SITE_PROD = '2';

/** URL publique de Rybbit (son `/api/track` est public, sans secret). */
const DEFAULT_TRACK_URL_PROD = 'https://analytics.app.veridian.site';

/** Rybbit jette en robot un appel sans en-têtes de navigateur. */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 VeridianHub',
  Accept: '*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

/** Court par design : on ne bloque jamais le hot-path signup/provision. */
const DEFAULT_TIMEOUT_MS = 2_500;

export type TrackGoalInput = {
  /**
   * Identité du prospect côté tunnel = email normalisé (lowercase/trim).
   * Le bridge relie cet email au slug visiteur en aval.
   */
  userEmail: string;
  /** Nom du goal Analytics (≤100 chars). Ex: `signup`, `app_started`. */
  goal: string;
  /**
   * Identifiant de session synthétique STABLE par user — convention
   * `hub-<userUuid>`. Stable = les events Hub d'un même user partagent une
   * session, ce qui aide la rétro-attribution côté engine.
   */
  sessionId: string;
  /** Propriétés libres (string→string). Ex: `{ provider: 'google' }`. */
  properties?: Record<string, string>;
  /** Chemin logique de l'event (défaut `/` — le Hub n'a pas de page tunnel). */
  path?: string;
  /** Requête du vrai visiteur : son IP et son navigateur, que Rybbit retient avec une clé de confiance. */
  request?: { headers: { get(name: string): string | null } };
};

type TrackGoalDeps = {
  fetchImpl?: typeof fetch;
  /** Logger mockable — par défaut console. */
  logger?: { warn: (...args: unknown[]) => void };
};

/** `true` si le runtime tourne en prod. */
function isProd(): boolean {
  return process.env.DEPLOY_ENV === 'prod';
}

/** Site Rybbit visé ; hors prod, seulement s'il est donné explicitement (sinon rien ne part). */
export function resolveSiteId(): string | null {
  return process.env.ANALYTICS_TRACK_SITE_ID || (isProd() ? SITE_PROD : null);
}

/** Base URL de Rybbit : `ANALYTICS_TRACK_URL` (+ `_STAGING` hors prod), sinon Rybbit prod. */
export function resolveTrackBaseUrl(): string {
  const override = isProd()
    ? process.env.ANALYTICS_TRACK_URL
    : process.env.ANALYTICS_TRACK_URL_STAGING ?? process.env.ANALYTICS_TRACK_URL;
  return (override || DEFAULT_TRACK_URL_PROD).replace(/\/+$/, '');
}

/**
 * Émet un goal vers Analytics. Best-effort : ne throw jamais, ne retry jamais.
 * Les call sites doivent l'invoquer en `void` sans await.
 */
export async function trackGoal(
  input: TrackGoalInput,
  deps: TrackGoalDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? console;

  try {
    const userId = input.userEmail.toLowerCase().trim();
    if (!userId) {
      logger.warn('[analytics:trackGoal] empty userEmail — skipping', {
        goal: input.goal,
      });
      return;
    }

    const siteId = resolveSiteId();
    if (!siteId) return; // hors prod sans site explicite : rien ne part
    // Ingestion serveur de confiance (clé ingest:write) : Rybbit prend l'IP et le navigateur du visiteur au
    // lieu de ceux du Hub. Sans elle, l'appel vient d'OVH et Rybbit le classe robot (mesuré le 09/11).
    const ipLue = input.request ? extractClientIp(input.request.headers as Headers) : '';
    const ip = isIP(ipLue) ? ipLue : undefined; // Rybbit refuse tout l'événement sur une IP invalide
    const ua = input.request?.headers.get('user-agent') || undefined;
    const cle = process.env.ANALYTICS_TRACK_KEY;
    const body = JSON.stringify({
      type: 'custom_event',
      ...(cle && ip ? { ip_address: ip } : {}),
      ...(cle && ua ? { user_agent: ua } : {}),
      site_id: siteId,
      event_name: input.goal,
      hostname: 'app.veridian.site',
      pathname: input.path ?? '/',
      user_id: userId,
      language: 'fr-FR',
      screenWidth: 1920,
      screenHeight: 1080,
      properties: JSON.stringify({ ...(input.properties ?? {}), session: input.sessionId, source: 'hub' }),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${resolveTrackBaseUrl()}/api/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...BROWSER_HEADERS,
          ...(cle ? { Authorization: `Bearer ${cle}` } : {}),
        },
        body,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('[analytics:trackGoal] non-2xx response (ignored)', {
          goal: input.goal,
          status: res.status,
          body: text.slice(0, 300),
        });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Catch-all : réseau, timeout (AbortError), JSON, tout. On n'escalade JAMAIS.
    logger.warn('[analytics:trackGoal] failed (ignored, best-effort)', {
      goal: input.goal,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Session synthétique stable par user : `hub-<userUuid>`. */
export function hubSessionId(userUuid: string): string {
  return `hub-${userUuid}`;
}
