/**
 * Les fils de discussion vivent dans l'app (Robert, 22/11) ; le Hub les relaie sans les garder.
 *
 * Contrat des apps du Hub (Academy…), signé comme les autres échanges Hub ↔ app (§6.1, HMAC sur `${ts}.${corps}`) :
 *   GET <APP>/api/hub/ia/fils/:session?hub_user_id=&tenant_id=  → { messages: UIMessage[] } ou 404
 *   PUT <APP>/api/hub/ia/fils/:session { hub_user_id, tenant_id, messages } → 200
 *
 * Le CRM n'en est plus : son chat natif range ses fils lui-même (fournisseur « Veridian », /api/ia/v1).
 *
 * L'app ne rend un fil qu'à son auteur et pour son tenant.
 */
import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { entetesSignature } from '@/lib/hmac/signature-hub';

const TIMEOUT_MS = 8_000;

export type CibleFil = {
  sessionId: string;
  hubUserId: string;
  tenantId: string;
};
type Opts = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch };

/** Adresse (sans query) et secret d'un appel de fil ; null si l'app n'est pas joignable pour ce fil. */
function appel(app: string, t: CibleFil, env: NodeJS.ProcessEnv) {
  const c = resolveAppConfig(app, env);
  if (!c) return null;
  return { url: `${c.apiUrl}/api/hub/ia/fils/${encodeURIComponent(t.sessionId)}`, secret: c.hubSecret };
}

export async function lireFil(app: string, t: CibleFil, opts: Opts = {}): Promise<unknown[] | null> {
  const a = appel(app, t, opts.env ?? process.env);
  if (!a) return null;
  const url = `${a.url}?${new URLSearchParams({ hub_user_id: t.hubUserId, tenant_id: t.tenantId })}`;
  const headers = entetesSignature({ secret: a.secret, methode: 'GET', url, corps: '', app });
  const r = await (opts.fetchImpl ?? fetch)(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = (await r.json().catch(() => null)) as { messages?: unknown[] } | null;
  return Array.isArray(j?.messages) ? j.messages : null;
}

export async function ecrireFil(app: string, t: CibleFil & { messages: unknown[] }, opts: Opts = {}): Promise<boolean> {
  const corps = JSON.stringify({ hub_user_id: t.hubUserId, tenant_id: t.tenantId, messages: t.messages });
  const a = appel(app, t, opts.env ?? process.env);
  if (!a) return false;
  const r = await (opts.fetchImpl ?? fetch)(a.url, {
    method: 'PUT',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...entetesSignature({ secret: a.secret, methode: 'PUT', url: a.url, corps, app }) },
    body: corps,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  return Boolean(r?.ok);
}
