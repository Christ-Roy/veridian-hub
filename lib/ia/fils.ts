/**
 * Les fils de discussion vivent dans l'app (Robert, 22/11) ; le Hub les relaie sans les garder.
 * Contrat, signé comme les autres échanges Hub ↔ app (§6.1, HMAC sur `${ts}.${corps}`) :
 *   GET <APP>/api/hub/ia/fils/:session?hub_user_id=&tenant_id=  → { messages: UIMessage[] } ou 404
 *   PUT <APP>/api/hub/ia/fils/:session { hub_user_id, tenant_id, messages } → 200
 * L'app ne rend un fil qu'à son auteur et pour son tenant.
 */
import { createHmac } from 'node:crypto';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';

const TIMEOUT_MS = 8_000;

function signer(secret: string, corps: string) {
  const ts = String(Date.now());
  return { ts, sig: createHmac('sha256', secret).update(`${ts}.${corps}`).digest('hex') };
}

export async function lireFil(
  app: string,
  t: { sessionId: string; hubUserId: string; tenantId: string },
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<unknown[] | null> {
  const c = resolveAppConfig(app, opts.env ?? process.env);
  if (!c) return null;
  const { ts, sig } = signer(c.hubSecret, '');
  const q = new URLSearchParams({ hub_user_id: t.hubUserId, tenant_id: t.tenantId });
  const r = await (opts.fetchImpl ?? fetch)(`${c.apiUrl}/api/hub/ia/fils/${encodeURIComponent(t.sessionId)}?${q}`, {
    headers: { 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': sig },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = (await r.json().catch(() => null)) as { messages?: unknown[] } | null;
  return Array.isArray(j?.messages) ? j.messages : null;
}

export async function ecrireFil(
  app: string,
  t: { sessionId: string; hubUserId: string; tenantId: string; messages: unknown[] },
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const c = resolveAppConfig(app, opts.env ?? process.env);
  if (!c) return false;
  const corps = JSON.stringify({ hub_user_id: t.hubUserId, tenant_id: t.tenantId, messages: t.messages });
  const { ts, sig } = signer(c.hubSecret, corps);
  const r = await (opts.fetchImpl ?? fetch)(`${c.apiUrl}/api/hub/ia/fils/${encodeURIComponent(t.sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': sig },
    body: corps,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  return Boolean(r?.ok);
}
