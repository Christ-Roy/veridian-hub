/**
 * Les fils de discussion vivent dans l'app (Robert, 22/11) ; le Hub les relaie sans les garder.
 *
 * Contrat des apps du Hub (Academy…), signé comme les autres échanges Hub ↔ app (§6.1, HMAC sur `${ts}.${corps}`) :
 *   GET <APP>/api/hub/ia/fils/:session?hub_user_id=&tenant_id=  → { messages: UIMessage[] } ou 404
 *   PUT <APP>/api/hub/ia/fils/:session { hub_user_id, tenant_id, messages } → 200
 *
 * Contrat du CRM (Twenty ne se touche que par plugin) : la route de la fonction serveur du plugin, sur l'origine
 * de l'espace (Twenty trouve le workspace par l'hôte), authentifiée par un JWT ES256 du Hub vérifiable par la
 * clé publique (/.well-known/jwks.json) : aucun secret à confier au plugin.
 *   GET <origine>/s/veridian-ia/fils/:session          Authorization: Bearer <jeton>
 *   PUT <origine>/s/veridian-ia/fils/:session { messages }  Authorization: Bearer <jeton>
 * Jeton : iss Hub, aud = l'URL exacte appelée, sub = hub_user_id, scope `ia.fils`, tenant_id, workspace_id,
 * session_id, corps_sha256 (sha256 hex du corps, chaîne vide pour GET), 60 s. Le plugin refuse si workspace_id
 * n'est pas le sien, et ne rend un fil qu'à son auteur.
 *
 * L'app ne rend un fil qu'à son auteur et pour son tenant.
 */
import { createHash, createHmac } from 'node:crypto';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { signerPourRouteApp } from '@/lib/mcp/identite';

const TIMEOUT_MS = 8_000;
export const CHEMIN_FILS_PLUGIN = '/s/veridian-ia/fils';

export type CibleFil = {
  sessionId: string;
  hubUserId: string;
  tenantId: string;
  /** Espace de l'app (Twenty) : requis pour le CRM. */
  workspaceId?: string | null;
  /** Origine de l'espace dans l'app (ex. https://acme.crm.app.veridian.site) : requise pour le CRM. */
  origine?: string | null;
};
type Opts = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };

function signer(secret: string, corps: string) {
  const ts = String(Date.now());
  return { ts, sig: createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex') };
}

/**
 * Origine d'un espace CRM acceptée : un sous-domaine direct de l'hôte de CRM_API_URL, en HTTPS. Le Hub
 * n'appelle jamais une autre adresse (pas de SSRF par un paramètre du navigateur).
 */
export function origineCrmValide(origine: unknown, env: NodeJS.ProcessEnv = process.env): origine is string {
  if (typeof origine !== 'string' || !env.CRM_API_URL) return false;
  let hote: string;
  try {
    hote = new URL(env.CRM_API_URL).hostname;
  } catch {
    return false;
  }
  const echappe = hote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${echappe}$`).test(origine);
}

function jetonPlugin(url: string, t: CibleFil, corps: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return signerPourRouteApp(
    {
      audience: url,
      hubUserId: t.hubUserId,
      claims: {
        scope: 'ia.fils',
        tenant_id: t.tenantId,
        workspace_id: t.workspaceId,
        session_id: t.sessionId,
        corps_sha256: createHash('sha256').update(corps).digest('hex'),
      },
    },
    env,
  );
}

/** Adresse et en-têtes d'un appel de fil, ou null si l'app n'est pas joignable pour ce fil. */
async function appel(app: string, t: CibleFil, corps: string, env: NodeJS.ProcessEnv) {
  if (app === 'crm') {
    if (!t.workspaceId || !origineCrmValide(t.origine, env)) return null;
    const url = `${t.origine}${CHEMIN_FILS_PLUGIN}/${encodeURIComponent(t.sessionId)}`;
    const jeton = await jetonPlugin(url, t, corps, env);
    return jeton ? { url, headers: { Authorization: `Bearer ${jeton}` } as Record<string, string> } : null;
  }
  const c = resolveAppConfig(app, env);
  if (!c) return null;
  const { ts, sig } = signer(c.hubSecret, corps);
  return { url: `${c.apiUrl}/api/hub/ia/fils/${encodeURIComponent(t.sessionId)}`, headers: { 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': sig } as Record<string, string> };
}

export async function lireFil(app: string, t: CibleFil, opts: Opts = {}): Promise<unknown[] | null> {
  const a = await appel(app, t, '', opts.env ?? process.env);
  if (!a) return null;
  // Le CRM tient l'auteur et l'espace dans le jeton ; les autres apps les reçoivent en paramètres signés.
  const url = app === 'crm' ? a.url : `${a.url}?${new URLSearchParams({ hub_user_id: t.hubUserId, tenant_id: t.tenantId })}`;
  const r = await (opts.fetchImpl ?? fetch)(url, { headers: a.headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = (await r.json().catch(() => null)) as { messages?: unknown[] } | null;
  return Array.isArray(j?.messages) ? j.messages : null;
}

export async function ecrireFil(app: string, t: CibleFil & { messages: unknown[] }, opts: Opts = {}): Promise<boolean> {
  const corps =
    app === 'crm'
      ? JSON.stringify({ messages: t.messages })
      : JSON.stringify({ hub_user_id: t.hubUserId, tenant_id: t.tenantId, messages: t.messages });
  const a = await appel(app, t, corps, opts.env ?? process.env);
  if (!a) return false;
  const r = await (opts.fetchImpl ?? fetch)(a.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...a.headers },
    body: corps,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  return Boolean(r?.ok);
}
