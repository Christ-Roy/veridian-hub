/**
 * Relie l'espace d'une app au tenant Hub (`POST <app>/api/tenants/link-hub`, HMAC §6.1), pour que
 * le `tenant_id` du JWT MCP y désigne cet espace. Lien seul : rien d'autre ne change chez l'app, et
 * un lien existant n'est jamais écrasé (docs/CONTRAT-MCP.md).
 */
import { createHmac } from 'node:crypto';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';

export type LienHub = { linked: boolean; raison: string };

export async function lierAuHub(
  app: 'analytics',
  input: { hubUserId: string; hubTenantId: string },
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<LienHub> {
  const config = resolveAppConfig(app, opts.env ?? process.env);
  if (!config) return { linked: false, raison: `${app}_not_configured` };
  const body = JSON.stringify({ hub_user_id: input.hubUserId, hub_tenant_id: input.hubTenantId });
  const ts = String(Date.now());
  const res = await (opts.fetchImpl ?? fetch)(`${config.apiUrl}/api/tenants/link-hub`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Veridian-Timestamp': ts,
      'X-Veridian-Hub-Signature': createHmac('sha256', config.hubSecret).update(`${ts}.${body}`).digest('hex'),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as { linked?: boolean; raison?: string; error?: string } | null;
  const raison = data?.raison ?? data?.error ?? `http_${res.status}`;
  // relie et deja_relie : l'espace est relié à ce tenant ; 409 lien_different ou tenant_hub_deja_pris : non.
  return { linked: res.ok && (data?.linked ?? true) && raison !== 'aucun_tenant', raison };
}
