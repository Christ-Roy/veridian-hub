/**
 * Provisioning du CRM Veridian (fork Twenty) depuis le Hub, CONTRAT-HUB §5.1 et §3.8.
 *
 * Le Hub crée l'espace Twenty d'un utilisateur par `POST <CRM_API_URL>/api/tenants/provision`,
 * signé HMAC (`${ts}.${corps}`). Aucun mot de passe ni jeton Twenty n'est gardé ici : l'utilisateur
 * entre ensuite par le rebond `issue-magic-link`, comme pour les autres apps.
 * Idempotent côté Twenty : un second appel pour le même tenant répond `created: false`.
 */
import { createHmac } from 'node:crypto';

import { resolveAppConfig } from '@/lib/auth/bounce-apps';

const PROVISION_PATH = '/api/tenants/provision';
const TIMEOUT_MS = 240_000; // création d'un espace Twenty : 12 s au calme, plus de 2 min sur nœud chargé

export interface CrmProvisionInput {
  tenantId: string;
  hubUserId: string;
  email: string;
  workspaceName: string;
}

export type CrmProvisionResult =
  | { ok: true; workspaceId: string; created: boolean }
  | { ok: false; error: string; status?: number };

export async function provisionCrmWorkspace(
  input: CrmProvisionInput,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; nowMs?: () => number } = {},
): Promise<CrmProvisionResult> {
  const config = resolveAppConfig('crm', opts.env ?? process.env);
  if (!config) return { ok: false, error: 'crm_not_configured' };

  // Twenty limite le nom à 32 caractères ; le Hub n'appelle une app que pour une adresse prouvée (§3.8).
  const body = JSON.stringify({
    tenant_id: input.tenantId,
    owner_email: input.email,
    workspace_name: input.workspaceName.slice(0, 32) || 'Veridian',
    plan: 'free',
    email_proven: true,
    metadata: { hub_user_id: input.hubUserId },
  });
  const timestamp = String((opts.nowMs ?? Date.now)());
  const signature = createHmac('sha256', config.hubSecret).update(`${timestamp}.${body}`).digest('hex');

  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(`${config.apiUrl}${PROVISION_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Veridian-Timestamp': timestamp,
        'X-Veridian-Hub-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `crm_unreachable: ${err instanceof Error ? err.message : 'network'}` };
  }

  const data = (await response.json().catch(() => null)) as
    | { workspace_id?: string; created?: boolean; error?: string }
    | null;
  if (!response.ok || !data?.workspace_id) {
    return { ok: false, error: data?.error ?? `crm_http_${response.status}`, status: response.status };
  }
  return { ok: true, workspaceId: data.workspace_id, created: data.created === true };
}
