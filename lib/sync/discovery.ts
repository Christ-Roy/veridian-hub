/**
 * Niveau 1 du tenant sync — Discovery pull.
 *
 * Pour un email donné, interroge chaque app downstream via
 * `GET /api/users/by-email?email=<x>` (HMAC Hub) et agrège les snapshots.
 *
 * Best-effort par design (Promise.allSettled + timeout court) : si Notifuse
 * timeout, on renvoie quand même les autres apps. Pas de cassure visible
 * pour l'utilisateur — la card de l'app indisponible reste cachée
 * silencieusement.
 *
 * ⚠️ Côté apps downstream : l'endpoint `GET /api/users/by-email` n'est PAS
 * encore implémenté (cf `todo/2026-05-20-hub-discovery-by-email-pattern.md`,
 * conformité 0/4 dans `docs/CONTRAT-HUB.md` §10.1 row 22). Tant qu'aucune
 * app ne le livre, cette fonction renverra `{ found: false }` partout — ce
 * qui est le comportement gracieux attendu (rien ne casse côté Hub).
 *
 * Tickets associés livrés côté apps :
 *   - `notifuse-veridian/todo/...-discovery-endpoint.md`
 *   - `veridian-prospection/todo/...-discovery-endpoint.md`
 *   - `veridian-cms/todo/...-discovery-endpoint.md`
 *   - `veridian-analytics/todo/...-discovery-endpoint.md`
 *
 * Référence : `todo/2026-05-20-tenant-sync-strategy.md` Niveau 1,
 *             `docs/CONTRAT-HUB.md` §5.12 (à enrichir avec by-email).
 */

import { createHmac } from 'node:crypto';

import type {
  DiscoveryAppResult,
  DiscoveryResult,
  SyncApp,
  TenantSnapshot,
} from '@/lib/sync/types';
import { SYNC_APPS } from '@/lib/sync/types';

/**
 * Timeout court par app : on préfère perdre une app de la liste que de
 * faire attendre le user. La discovery est appelée au login → critique
 * pour la perception de latence.
 */
const DEFAULT_TIMEOUT_MS = 2_000;

/** Map app → (URL ENV, secret ENV). Source de vérité pour le câblage. */
const APP_ENV_MAPPING: Record<
  SyncApp,
  { urlEnv: string; secretEnv: string; legacySecretEnv?: string }
> = {
  notifuse: {
    urlEnv: 'NOTIFUSE_API_URL',
    secretEnv: 'NOTIFUSE_HUB_API_SECRET',
  },
  prospection: {
    urlEnv: 'PROSPECTION_API_URL',
    secretEnv: 'PROSPECTION_HUB_API_SECRET',
    legacySecretEnv: 'PROSPECTION_TENANT_API_SECRET',
  },
  analytics: {
    urlEnv: 'ANALYTICS_API_URL',
    secretEnv: 'ANALYTICS_HUB_API_SECRET',
  },
  cms: {
    urlEnv: 'CMS_API_URL',
    secretEnv: 'CMS_HUB_API_SECRET',
  },
};

export interface DiscoverOptions {
  /** Timeout par app (ms). Défaut 2000. */
  timeoutMs?: number;
  /** Fetch impl pour injection en test. Défaut globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Liste d'apps à interroger. Défaut SYNC_APPS (toutes). */
  apps?: readonly SyncApp[];
}

/** Lit le secret HMAC d'une app (avec fallback legacy quand applicable). */
function readAppSecret(app: SyncApp): string | null {
  const mapping = APP_ENV_MAPPING[app];
  const primary = process.env[mapping.secretEnv];
  if (primary) return primary;
  if (mapping.legacySecretEnv) {
    return process.env[mapping.legacySecretEnv] ?? null;
  }
  return null;
}

/** Lit l'URL de base d'une app (sans trailing slash). */
function readAppUrl(app: SyncApp): string | null {
  const url = process.env[APP_ENV_MAPPING[app].urlEnv];
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

/**
 * Signe une requête GET selon le contrat HMAC standard §6.1 :
 *   sig = hmac_sha256(secret, `${ts}.${path}`)
 *
 * NB : pour un GET, le body est vide, donc on signe le path (avec
 * querystring) à la place. Les apps doivent valider ça côté serveur
 * (les clients Hub existants `lib/notifuse/client.ts` font pareil :
 * `body = ''` pour les GET, et la sig est juste `${ts}.`).
 *
 * On garde le format `${ts}.${rawBody}` ici aussi (body=''), pour rester
 * pixel-parfait avec les clients existants — sinon l'app aurait deux
 * conventions HMAC à gérer. Le path part dans l'URL, le timestamp anti-replay
 * dans le header, et la sig est sur `${ts}.`.
 */
function signGet(secret: string): { timestamp: string; signature: string } {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .digest('hex');
  return { timestamp, signature };
}

/**
 * Discovery pour UNE app. Renvoie toujours un DiscoveryAppResult (jamais throw).
 */
export async function discoverAppForEmail(
  app: SyncApp,
  email: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryAppResult> {
  const url = readAppUrl(app);
  const secret = readAppSecret(app);
  if (!url || !secret) {
    // Pas câblé en ENV — log à la première fois pour visibilité, puis silent.
    return {
      error: `app_not_configured: ${app} (missing ${APP_ENV_MAPPING[app].urlEnv} or ${APP_ENV_MAPPING[app].secretEnv})`,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { timestamp, signature } = signGet(secret);
  const fullUrl = `${url}/api/users/by-email?email=${encodeURIComponent(email)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(fullUrl, {
      method: 'GET',
      headers: {
        'X-Veridian-Timestamp': timestamp,
        'X-Veridian-Hub-Signature': signature,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.status === 404) {
      return { found: false };
    }

    if (!response.ok) {
      return {
        error: `http_${response.status}`,
        httpStatus: response.status,
      };
    }

    const body = (await response.json().catch(() => null)) as
      | {
          found?: boolean;
          workspaces?: Array<{
            workspace_id?: string;
            workspace_name?: string;
            role?: string;
            plan?: string;
            status?: string;
            magic_link_capable?: boolean;
            fallback_url?: string;
          }>;
        }
      | null;

    if (!body || body.found === false || !Array.isArray(body.workspaces)) {
      return { found: false };
    }

    const observedAt = new Date().toISOString();
    const snapshots: TenantSnapshot[] = body.workspaces
      .filter((w): w is { workspace_id: string } & typeof w =>
        typeof w?.workspace_id === 'string' && w.workspace_id.length > 0,
      )
      .map((w) => ({
        app,
        workspaceId: w.workspace_id,
        workspaceName: w.workspace_name,
        role: w.role,
        plan: w.plan,
        status:
          w.status === 'active' || w.status === 'suspended' || w.status === 'deleted'
            ? w.status
            : undefined,
        magicLinkCapable: w.magic_link_capable,
        fallbackUrl: w.fallback_url,
        observedAt,
      }));

    if (snapshots.length === 0) {
      return { found: false };
    }

    return { found: true, snapshots };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      error: isAbort
        ? `timeout_${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'unknown_error',
    };
  }
}

/**
 * Discovery cross-app pour un email donné. Lance les appels en parallèle.
 * Renvoie toujours un résultat (jamais throw) — chaque app est isolée.
 */
export async function discoverUserApps(
  email: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const apps = options.apps ?? SYNC_APPS;

  const settled = await Promise.allSettled(
    apps.map((app) => discoverAppForEmail(app, email, options)),
  );

  const result: Record<SyncApp, DiscoveryAppResult> = {
    notifuse: { found: false },
    prospection: { found: false },
    analytics: { found: false },
    cms: { found: false },
  };

  apps.forEach((app, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      result[app] = s.value;
    } else {
      result[app] = {
        error: s.reason instanceof Error ? s.reason.message : 'rejected',
      };
    }
  });

  return {
    email,
    apps: result,
    startedAt,
    durationMs: Date.now() - startMs,
  };
}
