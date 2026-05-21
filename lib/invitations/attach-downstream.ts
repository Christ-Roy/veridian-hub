/**
 * Client HMAC Hub → app downstream pour la phase 4b du flow invitation
 * cross-app (cf. ticket P1 `todo/2026-05-20-hub-invitation-endpoints.md`
 * + mémoire `reference_hub_invitation_hmac_contract.md`).
 *
 * Appelé depuis `lib/invitations/accept.ts` après que l'acceptation a été
 * enregistrée côté Hub (`hub_app.cross_app_invitations.acceptedAt`). Ce client
 * appelle `POST /api/veridian/workspaces/{id}/attach-member` (Prospection
 * convention) ou `POST /api/tenants/{id}/attach-member` (Notifuse convention)
 * selon l'app cible, avec un body `{hub_user_id, hub_user_email, role,
 * invitation_id}` signé HMAC.
 *
 * **Résilience** :
 *   - Si l'endpoint downstream n'existe pas encore (404) → on retourne
 *     `pending` au lieu d'échouer, pour permettre au Hub de progresser
 *     pendant que les apps livrent leur endpoint (état actuel 2026-05-21 :
 *     tickets `2026-05-21-hub-attach-member-endpoint.md` côté Notifuse et
 *     Prospection encore en cours d'implémentation).
 *   - Si l'endpoint répond 501 Not Implemented → idem `pending`.
 *   - Si timeout ou erreur réseau → `pending` (downstream peut être down ;
 *     pas une raison de refuser au user son acceptation côté Hub).
 *   - Si 5xx → `pending` après retry (l'invitation est déjà ack'd côté Hub,
 *     on peut re-tenter au prochain login).
 *
 * **Pas résilient** :
 *   - 401/403 (HMAC invalide) → exception, c'est une bug-sécu côté config.
 *   - 4xx autres (409 user_role_conflict, 423 tenant_suspended, etc.) →
 *     remonté tel quel à l'appelant (sémantique business spécifique).
 *
 * **Endpoints** :
 *   - Prospection : `POST /api/veridian/workspaces/{workspaceId}/attach-member`
 *   - Notifuse :   `POST /api/tenants/{tenantId}/attach-member`
 *   - Analytics, CMS : convention `/api/veridian/workspaces/{id}/attach-member`
 *     (à adapter quand les apps livreront le ticket — pour l'instant
 *     `pending` automatique car endpoint absent → 404).
 *
 * **Auth** : signature HMAC sha256 sur `${timestamp}.${rawBody}` avec
 * le secret EXISTANT par app (`<APP>_HUB_API_SECRET`, le même que pour
 * `/api/tenants/provision`, `/api/tenants/attach-owner`, etc.). Convention
 * gravée dans les 2 tickets attach-member (notifuse + prospection) :
 * "réutiliser le middleware HMAC existant, pas de nouveau secret dédié".
 *
 * Headers envoyés (convention unanime côté apps) :
 *   - `X-Veridian-Timestamp` (ms epoch)
 *   - `X-Veridian-Hub-Signature` (hex sha256(timestamp + '.' + rawBody))
 *
 * Pattern adapté de `lib/notifuse/client.ts` (signRequest + executeWithRetry),
 * sans la couche d'abstraction objet — un seul call point.
 */

import { createHmac } from 'node:crypto';

import { type SupportedApp } from './hmac';

/**
 * Résout le secret HMAC pour signer un appel Hub → app downstream.
 * Convention apps : `<APP>_HUB_API_SECRET` (cohérent avec
 * `lib/notifuse/admin-helpers.ts` et `lib/prospection/client.ts`).
 */
function resolveDownstreamSecret(
  app: SupportedApp,
  envOverride?: NodeJS.ProcessEnv,
): string | null {
  const env = envOverride ?? process.env;
  // Fallback chain : <APP>_HUB_API_SECRET (convention apps) puis
  // HUB_INVITATION_SECRET_<APP> (legacy, au cas où une migration aurait
  // déjà provisionné ce nom dans un compose — on accepte les 2).
  const primary = env[`${app.toUpperCase()}_HUB_API_SECRET`];
  if (primary && primary.trim().length > 0) return primary;
  const fallback = env[`HUB_INVITATION_SECRET_${app.toUpperCase()}`];
  if (fallback && fallback.trim().length > 0) return fallback;
  return null;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 1;

export type AttachDownstreamInput = {
  targetApp: SupportedApp;
  targetWorkspaceId: string;
  hubUserId: string;
  hubUserEmail: string;
  role: string;
  invitationId: string;
  /** Override base URL (tests + flexibilité multi-env). Si absent, on lit
   *  `NEXT_PUBLIC_<APP>_URL` puis fallback `https://<app>.app.veridian.site`. */
  baseUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override timeout (tests rapides). */
  timeoutMs?: number;
  /** Override secret (tests). Si absent → résolu depuis ENV via
   *  `resolveInvitationSecret(targetApp)`. */
  secretOverride?: string;
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override nb retries (tests veulent 0 pour rapidité). */
  maxRetries?: number;
};

export type AttachDownstreamOk = {
  status: 'completed';
  /** Login URL retourné par l'app downstream (auto-login TTL court). Si l'app
   *  n'a pas pu en générer un, peut être null/undefined. */
  loginUrl: string | null;
  alreadyMember: boolean;
  /** Code HTTP retourné par l'app downstream (200 idempotent ou 201 création). */
  httpStatus: 200 | 201;
};

export type AttachDownstreamPending = {
  status: 'pending';
  /** Raison machine-readable (pour audit log + debug, pas pour l'UI). */
  reason:
    | 'endpoint_not_found'
    | 'endpoint_not_implemented'
    | 'timeout'
    | 'network_error'
    | 'downstream_5xx'
    | 'secret_missing';
  /** Code HTTP downstream (null si pas atteint). */
  httpStatus: number | null;
};

export type AttachDownstreamError = {
  status: 'error';
  /** 401, 403 (HMAC invalide), 409 (role conflict), 423 (tenant suspended)... */
  httpStatus: number;
  /** Code error string remonté par l'app downstream (best-effort). */
  errorCode: string | null;
  reason: string;
};

export type AttachDownstreamResult =
  | AttachDownstreamOk
  | AttachDownstreamPending
  | AttachDownstreamError;

/**
 * Convention de chemin par app downstream. Note Notifuse utilise `/api/tenants`
 * historiquement (cohérence avec /provision, /suspend, /resume), les autres
 * apps utilisent `/api/veridian/workspaces` (machine-to-machine isolé du
 * user namespace).
 */
export function attachMemberPath(
  app: SupportedApp,
  workspaceId: string,
): string {
  const encoded = encodeURIComponent(workspaceId);
  switch (app) {
    case 'notifuse':
      return `/api/tenants/${encoded}/attach-member`;
    case 'prospection':
    case 'analytics':
    case 'cms':
    default:
      return `/api/veridian/workspaces/${encoded}/attach-member`;
  }
}

export function resolveDownstreamBaseUrl(
  app: SupportedApp,
  env?: NodeJS.ProcessEnv,
): string {
  const e = env ?? process.env;
  const byApp: Record<SupportedApp, string | undefined> = {
    notifuse: e.NEXT_PUBLIC_NOTIFUSE_URL,
    prospection: e.NEXT_PUBLIC_PROSPECTION_URL,
    analytics: e.NEXT_PUBLIC_ANALYTICS_URL,
    cms: e.NEXT_PUBLIC_CMS_URL,
  };
  const explicit = byApp[app];
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, '');
  return `https://${app}.app.veridian.site`;
}

/**
 * Appelle l'endpoint `attach-member` de l'app downstream pour propager
 * l'acceptation d'invitation. Renvoie un résultat structuré :
 *   - `completed` : downstream a confirmé l'attachement (avec loginUrl)
 *   - `pending`   : downstream pas (encore) capable (404, 501, timeout, 5xx)
 *                   — l'invitation reste valide côté Hub, l'UI affiche
 *                   "en cours d'attribution".
 *   - `error`     : downstream a retourné une erreur 4xx business (autre que
 *                   404/501) — l'UI doit afficher un message clair.
 *
 * Pas d'exception : tout est mappé en union type pour que l'appelant gère
 * tous les cas explicitement.
 */
export async function attachMemberDownstream(
  input: AttachDownstreamInput,
): Promise<AttachDownstreamResult> {
  const secret =
    input.secretOverride ??
    resolveDownstreamSecret(input.targetApp, input.env) ??
    null;
  if (!secret) {
    return {
      status: 'pending',
      reason: 'secret_missing',
      httpStatus: null,
    };
  }

  const baseUrl = (
    input.baseUrl ?? resolveDownstreamBaseUrl(input.targetApp, input.env)
  ).replace(/\/+$/, '');
  const path = attachMemberPath(input.targetApp, input.targetWorkspaceId);
  const url = `${baseUrl}${path}`;

  // Body : on sérialise UNE fois pour signer et envoyer les bytes EXACTS.
  const bodyObj = {
    hub_user_id: input.hubUserId,
    hub_user_email: input.hubUserEmail,
    role: input.role,
    invitation_id: input.invitationId,
  };
  const rawBody = JSON.stringify(bodyObj);

  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-veridian-app': 'hub',
    // Convention unanime apps (Notifuse Go middleware veridian_hmac.go,
    // Prospection src/lib/hub/hmac.ts) : X-Veridian-Timestamp + X-Veridian-Hub-Signature.
    'X-Veridian-Timestamp': timestamp,
    'X-Veridian-Hub-Signature': signature,
  };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl = input.fetchImpl ?? fetch;

  let lastNetworkError: 'timeout' | 'network_error' | null = null;
  let lastServerStatus: number | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Endpoint absent côté app → marqueur pending (l'app a pas encore livré
      // son ticket attach-member). Important : on ne raise PAS.
      if (res.status === 404) {
        return {
          status: 'pending',
          reason: 'endpoint_not_found',
          httpStatus: 404,
        };
      }
      if (res.status === 501) {
        return {
          status: 'pending',
          reason: 'endpoint_not_implemented',
          httpStatus: 501,
        };
      }

      // 5xx → retry si possible, sinon pending (l'app est down, on ne
      // bloquera pas l'acceptation côté Hub).
      if (res.status >= 500 && res.status < 600) {
        lastServerStatus = res.status;
        if (attempt < maxRetries) {
          continue;
        }
        return {
          status: 'pending',
          reason: 'downstream_5xx',
          httpStatus: res.status,
        };
      }

      // 2xx → succès.
      if (res.status === 200 || res.status === 201) {
        let json: any = null;
        try {
          json = await res.json();
        } catch {
          // body non-JSON, on tolère mais on n'a pas de loginUrl.
        }
        return {
          status: 'completed',
          loginUrl:
            (json && typeof json.login_url === 'string'
              ? (json.login_url as string)
              : null) ?? null,
          alreadyMember: !!(json && json.already_member === true),
          httpStatus: res.status as 200 | 201,
        };
      }

      // 4xx hors 404 → erreur business explicite.
      let errorCode: string | null = null;
      let reasonText = `downstream returned ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson && typeof errJson.error === 'string') {
          errorCode = errJson.error;
          reasonText = `${reasonText} (${errJson.error})`;
        }
      } catch {
        // ignore
      }
      return {
        status: 'error',
        httpStatus: res.status,
        errorCode,
        reason: reasonText,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        lastNetworkError = 'timeout';
      } else {
        lastNetworkError = 'network_error';
      }
      if (attempt < maxRetries) {
        continue;
      }
    }
  }

  // On a épuisé les retries sur erreur réseau ou 5xx.
  if (lastServerStatus !== null) {
    return {
      status: 'pending',
      reason: 'downstream_5xx',
      httpStatus: lastServerStatus,
    };
  }
  return {
    status: 'pending',
    reason: lastNetworkError ?? 'network_error',
    httpStatus: null,
  };
}
