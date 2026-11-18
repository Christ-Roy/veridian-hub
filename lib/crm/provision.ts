/**
 * Provisioning du CRM Veridian (fork Twenty) depuis le Hub, CONTRAT-HUB §5.1 et §3.8.
 *
 * Le Hub crée l'espace Twenty d'un utilisateur par `POST <CRM_API_URL>/api/tenants/provision`,
 * signé HMAC (`${ts}.${corps}`). Aucun mot de passe ni jeton Twenty n'est gardé ici : l'utilisateur
 * entre ensuite par le rebond `issue-magic-link`, comme pour les autres apps.
 * Idempotent côté Twenty : un second appel pour le même tenant répond `created: false`.
 */
import { createHmac } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { oublierUtilisateur } from '@/lib/mcp/cache';
import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { pushUserToApps } from '@/lib/identity/push-user';
import { isCanonicalPlan, readAppPlan, setAppPlan } from '@/lib/plans/app-plan';
import { setTenantAppEnabled } from '@/lib/tenant-apps';

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

type CrmDb = Pick<PrismaClient, 'tenant' | 'tenantApp' | 'tenantTrial' | 'subscription'>;

/**
 * Garantit l'espace CRM d'un utilisateur à adresse prouvée : à l'activation admin et à la première
 * ouverture (rebond refusé `user_not_in_app`). Le Hub retient l'espace dans `metadata.crm`, que
 * reconcile lit, et active l'app `twenty` pour que la carte du tableau de bord reste juste.
 */
export async function ensureCrmWorkspace(
  db: CrmDb,
  user: { hubUserId: string; email: string; name?: string | null },
  opts: { actorEmail?: string | null; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<CrmProvisionResult> {
  const tenant = await db.tenant.findFirst({
    where: { userId: user.hubUserId, deletedAt: null },
    select: { id: true, name: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!tenant) return { ok: false, error: 'tenant_not_found', status: 404 };

  const provision = await provisionCrmWorkspace(
    {
      tenantId: tenant.id,
      hubUserId: user.hubUserId,
      email: user.email.toLowerCase(),
      workspaceName: tenant.name || user.name || user.email.split('@')[0],
    },
    opts,
  );
  if (!provision.ok) return provision;
  // Twenty nomme le compte d'après l'adresse : le nom du Hub fait foi (§3.8), sinon reconcile compte un écart.
  if (user.name) {
    await pushUserToApps({ hubUserId: user.hubUserId, name: user.name }, { apps: ['crm'], fetchImpl: opts.fetchImpl, retryDelaysMs: [] });
  }

  const current =
    tenant.metadata && typeof tenant.metadata === 'object' && !Array.isArray(tenant.metadata)
      ? (tenant.metadata as Record<string, unknown>)
      : {};
  await db.tenant.update({
    where: { id: tenant.id },
    data: {
      metadata: {
        ...current,
        crm: { workspace_id: provision.workspaceId, provisioned_at: new Date().toISOString() },
      },
    },
  });
  await setTenantAppEnabled(db, {
    userUuid: user.hubUserId,
    appKey: 'twenty',
    enabled: true,
    actorEmail: opts.actorEmail ?? null,
  });
  // La porte MCP ne doit pas garder « injoignable » pour un compte qui vient d'être créé.
  oublierUtilisateur(user.hubUserId, 'twenty');
  // Le plan suit l'espace dès sa création (CONTRAT-BILLING §3) : celui du Hub, sinon free. Meilleur
  // effort : l'espace existe, un refus du plan se lit dans reconcile, il ne bloque pas l'ouverture.
  const actuel = readAppPlan(current, 'crm').plan;
  const plan = await setAppPlan(
    db,
    {
      tenantId: tenant.id,
      app: 'crm',
      plan: isCanonicalPlan(actuel) ? actuel : 'free',
      planSource: 'grant_manual',
      reason: 'création de l\'espace CRM',
      setBy: opts.actorEmail ?? 'hub',
    },
    opts,
  ).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!plan.ok) {
    console.warn(JSON.stringify({ tag: '[crm][plan]', level: 'warn', tenant_id: tenant.id, error: plan.error }));
  }
  return provision;
}
