/**
 * Couche 4 — Bounce OAuth Hub : client HMAC vers les apps downstream pour
 * récupérer un magic link après OAuth Hub réussi.
 *
 * Spec : `docs/CONTRAT-HUB.md` §6bis.8.3 — endpoint
 *
 *     POST <app>/api/sso/issue-magic-link
 *     Headers: X-Veridian-Hub-Signature (HMAC §6.1), X-Veridian-Timestamp
 *     Body:    { "hub_user_id": "<uuid>", "email": "<string>", "email_proven"?: true }
 *
 *     Réponses :
 *       200 → { magic_link_url: "https://<app>.../auth/token?t=..." }
 *       400 → { error: "user_not_in_app", hint: "..." }
 *       5xx → app HS
 *
 * Conventions ENV (cf. CONTRAT-HUB §6.5) :
 *   - URL    : `<APP>_API_URL` (réutilisée — la même que pour provisioning)
 *   - SECRET : `<APP>_HUB_API_SECRET` (réutilisé — pas de nouveau secret)
 *
 * Apps supportées (extensible) : `notifuse`, `prospection`, `cms`, `analytics`
 * (Rybbit, hôte `analytics.app.veridian.site`), `crm` (Twenty, hôte
 * `crm.app.veridian.site`). La clé est le sous-domaine extrait par `parseNext`.
 *
 * Twenty s'active sans code dès que son endpoint existe : poser `CRM_API_URL` et
 * `CRM_HUB_API_SECRET` dans l'environnement du Hub. Avant ça : `not_configured`.
 *
 * NB : pour `notifuse`, on accepte aussi `NOTIFUSE_HUB_API_SECRET` qui existe
 *      déjà. Pour `prospection`, fallback legacy `PROSPECTION_TENANT_API_SECRET`
 *      géré dans `lib/prospection/client.ts:readProspectionSecret`. Ici on reste
 *      strict : si le secret canonique n'est pas trouvé, on échoue net.
 */

import { entetesSignature } from '@/lib/hmac/signature-hub';

const ISSUE_MAGIC_LINK_PATH = '/api/sso/issue-magic-link';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Types d'erreur business retournés par l'endpoint downstream.
 *
 * `unreachable` : app HS / 5xx / timeout / réseau / 404 (l'endpoint n'existe
 *                 pas encore côté apps — pendant la phase de rollout).
 * `user_not_in_app` : 400 propre — l'user a un compte Hub mais pas dans cette
 *                     app. Le Hub redirige vers `/dashboard?app=<app>&hint=signup`.
 * `hub_user_conflict` : 400 propre — le compte de l'app est déjà relié à un AUTRE compte Hub
 *                       (une personne qui a plusieurs comptes Hub). Défini, jamais deviné.
 * `workspace_suspended` : 423, tous les espaces de la personne dans cette app sont suspendus (ou celui qu'elle demande).
 * `invalid_response` : réponse 200 mais sans `magic_link_url` parseable.
 * `not_configured` : ENV var manquante côté Hub (URL ou secret) — l'app n'est
 *                    pas câblée.
 */
export type BounceErrorCode =
  | 'unreachable'
  | 'user_not_in_app'
  | 'hub_user_conflict'
  | 'workspace_suspended'
  | 'invalid_response'
  | 'not_configured';

export class BounceError extends Error {
  constructor(
    public readonly code: BounceErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'BounceError';
  }
}

export interface IssueMagicLinkInput {
  app: string;
  hubUserId: string;
  email: string;
  /** Adresse prouvée au Hub : seule condition pour qu'une app relie par email. */
  emailProven?: boolean;
  /** Page demandée : l'app y renvoie après connexion, si elle est sur sa propre origine. */
  next?: string;
  /** Rôle du compte dans ses organisations (CONTRAT-HUB §5.22). Vide ou absent : l'app ne change rien. */
  /** Poignées de délégation de ce compte pour cette app (VER-245 b.2), une par organisation. */
  delegations?: { hub_tenant_id: string; grant: string; expire_le: string }[];
  organisations?: { hub_tenant_id: string; role: string; version: number }[];
  /** Organisation active choisie au Hub, revérifiée (VER-252) : où arriver. Absente : l'app garde son choix. */
  hubTenantId?: string | null;
  /** Session d'emprunt (VER-263) : qui est vraiment devant l'écran, et jusqu'à quand. L'app le garde dans son journal. */
  emprunt?: { id: string; par: string; expire_le: string } | null;
}

export interface IssueMagicLinkSuccess {
  magicLinkUrl: string;
  /** L'app a dit avoir gardé trace de l'emprunt (`emprunt_journalise: true`). */
  empruntJournalise?: boolean;
}

/** Résolu de l'ENV : config réseau pour bouncer vers une app. */
export interface BounceAppConfig {
  appName: string;
  apiUrl: string;
  hubSecret: string;
}

/**
 * Mapping app → (ENV var URL, ENV var SECRET).
 *
 * Doit rester strictement aligné avec les conventions documentées dans
 * `CONTRAT-HUB.md` §6.5. Ajouter une app = ajouter une entrée ici (pas de
 * convention magique pour éviter les surprises et garder l'audit clair).
 */
const APP_ENV_MAP: Record<
  string,
  { urlVar: string; secretVar: string; legacySecretVar?: string }
> = {
  notifuse: {
    urlVar: 'NOTIFUSE_API_URL',
    secretVar: 'NOTIFUSE_HUB_API_SECRET',
  },
  prospection: {
    urlVar: 'PROSPECTION_API_URL',
    secretVar: 'PROSPECTION_HUB_API_SECRET',
    // Fallback legacy aligné sur lib/prospection/client.ts:readProspectionSecret
    // et lib/sync/discovery.ts. En prod seul PROSPECTION_TENANT_API_SECRET est
    // posé — sans ce fallback, resolveAppConfig retourne null et le bounce
    // OAuth échoue en `not_configured`.
    legacySecretVar: 'PROSPECTION_TENANT_API_SECRET',
  },
  cms: {
    urlVar: 'CMS_API_URL',
    secretVar: 'CMS_HUB_API_SECRET',
  },
  analytics: {
    urlVar: 'ANALYTICS_API_URL',
    secretVar: 'ANALYTICS_HUB_API_SECRET',
  },
  // Hôte staging de Rybbit : `analytics-rybbit.staging.veridian.site`.
  'analytics-rybbit': {
    urlVar: 'ANALYTICS_API_URL',
    secretVar: 'ANALYTICS_HUB_API_SECRET',
  },
  crm: {
    urlVar: 'CRM_API_URL',
    secretVar: 'CRM_HUB_API_SECRET',
  },
  // Academy (e-learning, hôte `academy.app.veridian.site`), même contrat que le CRM.
  academy: {
    urlVar: 'ACADEMY_API_URL',
    secretVar: 'ACADEMY_HUB_API_SECRET',
  },
};

/**
 * Résout la config (URL + secret HMAC) pour une app.
 *
 * Retourne `null` si l'app est inconnue ou si l'une des deux ENV est absente.
 * Le caller doit traiter `null` comme `BounceError(not_configured)`.
 *
 * Pour les tests unitaires, on permet d'injecter un `env` custom (sinon
 * `process.env`).
 */
export function resolveAppConfig(
  app: string,
  env: NodeJS.ProcessEnv = process.env,
): BounceAppConfig | null {
  const mapping = APP_ENV_MAP[app];
  if (!mapping) return null;
  const apiUrl = env[mapping.urlVar];
  const hubSecret =
    env[mapping.secretVar] ||
    (mapping.legacySecretVar ? env[mapping.legacySecretVar] : undefined);
  if (!apiUrl || !hubSecret) return null;
  return {
    appName: app,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    hubSecret,
  };
}

/**
 * Liste les apps officiellement déclarées (pour les tests + audit).
 */
export function listSupportedApps(): string[] {
  return Object.keys(APP_ENV_MAP);
}

/**
 * Appelle `POST <app>/api/sso/issue-magic-link` en HMAC §6.1 et retourne
 * `{magicLinkUrl}` sur succès.
 *
 * @throws BounceError pour tout chemin d'erreur (user_not_in_app, 5xx,
 *         timeout, parse, ENV manquante).
 */
export async function issueMagicLinkForApp(
  input: IssueMagicLinkInput,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    nowMs?: () => number;
  } = {},
): Promise<IssueMagicLinkSuccess> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowMs = opts.nowMs ?? (() => Date.now());

  const config = resolveAppConfig(input.app, env);
  if (!config) {
    throw new BounceError(
      'not_configured',
      `bounce: app "${input.app}" not configured (missing URL or secret env)`,
    );
  }

  const url = `${config.apiUrl}${ISSUE_MAGIC_LINK_PATH}`;
  const body = JSON.stringify({
    hub_user_id: input.hubUserId,
    email: input.email,
    ...(input.emailProven ? { email_proven: true } : {}),
    ...(input.next ? { next: input.next } : {}),
    ...(input.delegations?.length ? { delegations: input.delegations } : {}),
    ...(input.hubTenantId ? { hub_tenant_id: input.hubTenantId } : {}),
    ...(input.organisations?.length ? { organisations: input.organisations } : {}),
    ...(input.emprunt ? { emprunt: input.emprunt } : {}),
  });

  const signature = entetesSignature({ secret: config.hubSecret, methode: 'POST', url, corps: body, app: input.app, maintenant: nowMs() });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signature,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `timeout ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'network';
    throw new BounceError(
      'unreachable',
      `bounce: ${input.app} ${ISSUE_MAGIC_LINK_PATH} unreachable (${reason})`,
    );
  }
  clearTimeout(timer);

  // 404 → endpoint pas encore implémenté côté app : traité comme 5xx (unreachable).
  // 405/501 → idem.
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    throw new BounceError(
      'unreachable',
      `bounce: ${input.app} ${ISSUE_MAGIC_LINK_PATH} not implemented (HTTP ${response.status})`,
      response.status,
    );
  }

  if (response.status >= 500) {
    throw new BounceError(
      'unreachable',
      `bounce: ${input.app} ${ISSUE_MAGIC_LINK_PATH} returned HTTP ${response.status}`,
      response.status,
    );
  }

  // 400 — distinguer user_not_in_app du reste.
  if (response.status === 400) {
    const body = await safeReadJson(response);
    const errCode =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : null;
    if (errCode === 'user_not_in_app') {
      throw new BounceError(
        'user_not_in_app',
        `bounce: ${input.app} reports user_not_in_app for ${input.email}`,
        400,
      );
    }
    if (errCode === 'hub_user_conflict') {
      throw new BounceError(
        'hub_user_conflict',
        `bounce: ${input.app} account already linked to another hub_user_id`,
        400,
      );
    }
    throw new BounceError(
      'unreachable',
      `bounce: ${input.app} returned 400 (${errCode ?? 'unknown'})`,
      400,
    );
  }

  if (response.status === 423) {
    throw new BounceError('workspace_suspended', `bounce: ${input.app} workspace suspended`, 423);
  }

  if (response.status === 401 || response.status === 403) {
    // HMAC mismatch / secret désync — sévère, log comme unreachable
    throw new BounceError(
      'unreachable',
      `bounce: ${input.app} auth failed (HTTP ${response.status} — secret désync ?)`,
      response.status,
    );
  }

  if (!response.ok) {
    throw new BounceError(
      'unreachable',
      `bounce: ${input.app} returned unexpected HTTP ${response.status}`,
      response.status,
    );
  }

  const parsed = await safeReadJson(response);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('magic_link_url' in parsed) ||
    typeof (parsed as { magic_link_url: unknown }).magic_link_url !== 'string'
  ) {
    throw new BounceError(
      'invalid_response',
      `bounce: ${input.app} 200 but missing magic_link_url`,
    );
  }

  const magicLinkUrl = (parsed as { magic_link_url: string }).magic_link_url;

  // Sanity check : le magic link DOIT pointer sur un host *.veridian.site
  // (anti-tentative app compromise qui redirigerait vers evil.com).
  if (!isVeridianHost(magicLinkUrl)) {
    throw new BounceError(
      'invalid_response',
      `bounce: ${input.app} returned magic_link_url with non-veridian host`,
    );
  }

  return { magicLinkUrl, empruntJournalise: (parsed as { emprunt_journalise?: unknown }).emprunt_journalise === true };
}

/** Vérifie que l'URL est en https et sur un host *.veridian.site (prod ou staging). */
function isVeridianHost(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.host.toLowerCase().split(':')[0];
  return /\.veridian\.site$/.test(host);
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
