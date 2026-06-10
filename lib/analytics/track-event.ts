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
 * SCHÉMA — `POST /api/track` (engine, endpoint public `@Public() @SkipRateLimit()`)
 * Sondé en réel le 2026-06-11 contre prod. Points DURS :
 *   - `created_at` / `updated_at` / `actions[].timestamp` = epoch **ms (number)**,
 *     pas ISO 8601, et doivent rester à ±24h de l'instant serveur engine.
 *   - enveloppe : workspace_id, session_id, user_id (≤256), actions[] (≤1000).
 *   - goal : name (≤100), path, page_number, timestamp, properties (string map).
 *   - les champs d'enveloppe inconnus sont strippés silencieusement (whitelist).
 *
 * Server-only par convention (comme `lib/notifuse/client.ts` et
 * `lib/analytics/client.ts`) : lit des ENV runtime, à n'importer QUE depuis du
 * code serveur (routes API, events Auth.js). Jamais depuis un composant client.
 */

/** Workspaces tunnel Analytics (cf carte reco analytics.md §2). */
const WORKSPACE_PROD = 'vrd_veridian_site_prod';
const WORKSPACE_STAGING = 'vrd_veridian_site_staging';

/** URL publique de l'engine d'ingestion (PAS le service admin provisioning). */
const DEFAULT_TRACK_URL_PROD = 'https://analytics-engine.app.veridian.site';
const DEFAULT_TRACK_URL_STAGING =
  'https://analytics-engine.staging.veridian.site';

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
};

type TrackGoalDeps = {
  fetchImpl?: typeof fetch;
  /** Logger mockable — par défaut console. */
  logger?: { warn: (...args: unknown[]) => void };
  /** Horloge injectable pour des tests déterministes. */
  now?: () => number;
};

/** `true` si le runtime tourne en prod (sinon staging/local → workspace staging). */
function isProd(): boolean {
  return process.env.DEPLOY_ENV === 'prod';
}

/** Workspace tunnel selon l'environnement de déploiement. */
export function resolveWorkspaceId(): string {
  return isProd() ? WORKSPACE_PROD : WORKSPACE_STAGING;
}

/**
 * Base URL de l'engine. Override possible via `ANALYTICS_TRACK_URL` (+ variante
 * `_STAGING`), sinon fallback sur l'URL publique connue. Pas de secret ici :
 * `/api/track` est un endpoint public.
 */
export function resolveTrackBaseUrl(): string {
  const override = isProd()
    ? process.env.ANALYTICS_TRACK_URL
    : process.env.ANALYTICS_TRACK_URL_STAGING ?? process.env.ANALYTICS_TRACK_URL;
  const base = override || (isProd() ? DEFAULT_TRACK_URL_PROD : DEFAULT_TRACK_URL_STAGING);
  return base.replace(/\/+$/, '');
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
  const now = deps.now ?? Date.now;

  try {
    const userId = input.userEmail.toLowerCase().trim();
    if (!userId) {
      logger.warn('[analytics:trackGoal] empty userEmail — skipping', {
        goal: input.goal,
      });
      return;
    }

    const ts = now();
    const body = JSON.stringify({
      workspace_id: resolveWorkspaceId(),
      session_id: input.sessionId,
      user_id: userId,
      created_at: ts,
      updated_at: ts,
      actions: [
        {
          type: 'goal',
          name: input.goal,
          path: input.path ?? '/',
          page_number: 1,
          timestamp: ts,
          ...(input.properties ? { properties: input.properties } : {}),
        },
      ],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${resolveTrackBaseUrl()}/api/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
