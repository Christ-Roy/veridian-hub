/**
 * Création de l'espace d'un utilisateur dans une app à espace par utilisateur, CONTRAT-HUB §5.1 et §3.8.
 *
 * Le Hub crée l'espace par `POST <APP>_API_URL/api/tenants/provision`, signé HMAC (`${ts}.${corps}`).
 * Aucun mot de passe ni jeton de l'app n'est gardé ici : l'utilisateur entre ensuite par le rebond
 * `issue-magic-link`. Idempotent côté app : un second appel pour le même tenant répond `created: false`.
 *
 * Deux apps suivent ce contrat : le CRM (Twenty) et Academy. Une troisième s'ajoute à `ESPACE_APPS`,
 * pas en recopiant ce fichier.
 */
import type { PrismaClient } from '@prisma/client';

import { nomDEspace } from '@/lib/apps/nom-espace';
import { resolveAppConfig } from '@/lib/auth/bounce-apps';
import { abonnerParDefaut } from '@/lib/evenements/naissance';
import { entetesSignature } from '@/lib/hmac/signature-hub';
import { pushUserToApps } from '@/lib/identity/push-user';
import { oublierUtilisateur } from '@/lib/mcp/cache';
import { choisirPlanInitial, setAppPlan, type PlanApp } from '@/lib/plans/app-plan';
import type { SyncApp } from '@/lib/sync/types';
import { setTenantAppEnabled, type GatedAppKey } from '@/lib/tenant-apps';
import { assurerTenantHub } from '@/lib/tenants/assurer';
import { fusionnerMetadata } from '@/lib/tenants/metadata-fusion';

const PROVISION_PATH = '/api/tenants/provision';

export interface EspaceAppConfig {
  /** Clé de l'app au Hub : variables `<APP>_API_URL`, plan, synchro d'identité, `metadata.<app>`. */
  app: PlanApp & SyncApp;
  /** Clé `tenant_apps` (activation, tuile, porte MCP). */
  appKey: GatedAppKey;
  /** Longueur maximale du nom d'espace acceptée par l'app. */
  nameMax: number;
  timeoutMs: number;
}

export const ESPACE_APPS = {
  // Création d'un espace Twenty : 12 s au calme, plus de 2 min sur nœud chargé. Nom limité à 32.
  crm: { app: 'crm', appKey: 'twenty', nameMax: 32, timeoutMs: 240_000 },
  academy: { app: 'academy', appKey: 'academy', nameMax: 64, timeoutMs: 30_000 },
} as const satisfies Record<string, EspaceAppConfig>;

export interface EspaceProvisionInput {
  tenantId: string;
  hubUserId: string;
  email: string;
  workspaceName: string;
}

export type EspaceProvisionResult =
  | { ok: true; workspaceId: string; created: boolean }
  | { ok: false; error: string; status?: number };

type Opts = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; nowMs?: () => number };

export async function provisionAppWorkspace(
  cfg: EspaceAppConfig,
  input: EspaceProvisionInput,
  opts: Opts = {},
): Promise<EspaceProvisionResult> {
  const config = resolveAppConfig(cfg.app, opts.env ?? process.env);
  if (!config) return { ok: false, error: `${cfg.app}_not_configured` };

  // Le Hub n'appelle une app que pour une adresse prouvée (§3.8).
  const body = JSON.stringify({
    tenant_id: input.tenantId,
    owner_email: input.email,
    workspace_name: nomDEspace(input.workspaceName, input.email).slice(0, cfg.nameMax) || 'Veridian',
    plan: 'free',
    email_proven: true,
    metadata: { hub_user_id: input.hubUserId },
  });
  const cible = `${config.apiUrl}${PROVISION_PATH}`;
  const signature = entetesSignature({ secret: config.hubSecret, methode: 'POST', url: cible, corps: body, app: cfg.app, maintenant: (opts.nowMs ?? Date.now)() });

  let response: Response;
  try {
    response = await (opts.fetchImpl ?? fetch)(cible, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signature,
      },
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `${cfg.app}_unreachable: ${err instanceof Error ? err.message : 'network'}` };
  }

  const data = (await response.json().catch(() => null)) as
    | { workspace_id?: string; created?: boolean; error?: string }
    | null;
  if (!response.ok || !data?.workspace_id) {
    return { ok: false, error: data?.error ?? `${cfg.app}_http_${response.status}`, status: response.status };
  }
  return { ok: true, workspaceId: data.workspace_id, created: data.created === true };
}

type EspaceDb = Pick<PrismaClient, 'tenant' | 'tenantApp' | 'tenantTrial' | 'subscription'>;

/**
 * Garantit l'espace d'un utilisateur à adresse prouvée : à l'activation admin, à la première ouverture
 * (rebond refusé `user_not_in_app`) et par la porte MCP. Le Hub retient l'espace dans `metadata.<app>`,
 * que reconcile lit, et active l'app dans `tenant_apps` pour que la tuile du tableau de bord reste juste.
 */
export async function ensureAppWorkspace(
  cfg: EspaceAppConfig,
  db: EspaceDb,
  user: { hubUserId: string; email: string; name?: string | null },
  opts: { actorEmail?: string | null } & Omit<Opts, 'nowMs'> = {},
): Promise<EspaceProvisionResult> {
  // Le tenant Hub est créé s'il manque (compte sans Notifuse ni Prospection) : sans lui, pas d'espace.
  const tenantId = await assurerTenantHub(db, user.email.toLowerCase(), user.hubUserId, user.name);
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, metadata: true },
  });
  if (!tenant) return { ok: false, error: 'tenant_not_found', status: 404 };

  const provision = await provisionAppWorkspace(
    cfg,
    {
      tenantId: tenant.id,
      hubUserId: user.hubUserId,
      email: user.email.toLowerCase(),
      workspaceName: tenant.name || user.name || user.email.split('@')[0],
    },
    opts,
  );
  if (!provision.ok) return provision;
  // L'app nomme le compte d'après l'adresse : le nom du Hub fait foi (§3.8), sinon reconcile compte un écart.
  if (user.name) {
    await pushUserToApps(
      { hubUserId: user.hubUserId, name: user.name },
      { apps: [cfg.app], fetchImpl: opts.fetchImpl, retryDelaysMs: [] },
    );
  }

  // Les seules clés de ce geste, fusionnées par la base : jamais le JSON entier relu avant (26/11, lib/tenants/metadata-fusion.ts).
  await fusionnerMetadata(db, tenant.id, {
    [cfg.app]: { workspace_id: provision.workspaceId, provisioned_at: new Date().toISOString() },
  });
  await setTenantAppEnabled(db, {
    userUuid: user.hubUserId,
    appKey: cfg.appKey,
    enabled: true,
    actorEmail: opts.actorEmail ?? null,
  });
  // Une organisation neuve dont Mail et le CRM sont ouverts : sa liaison par défaut. Jamais bloquant.
  if (cfg.app === 'crm') void abonnerParDefaut(db as unknown as Parameters<typeof abonnerParDefaut>[0], tenant.id);
  // La porte MCP ne doit pas garder « injoignable » pour un compte qui vient d'être créé.
  oublierUtilisateur(user.hubUserId, cfg.appKey);
  // Aucun plan n'est inventé à la création (décision du 22/11) : l'app garde le `free` du
  // provisionnement, sans `plan_source`, et Stripe peut le faire monter. Un `grant_manual` posé ici
  // rendait ce free « offert », donc immunisé : le premier abonné restait en free, sans erreur.
  // Un plan déjà choisi au Hub est repoussé avec sa propre source. Meilleur effort : un refus se lit
  // dans reconcile, il ne bloque pas l'ouverture.
  // Le plan déjà posé se lit dans metadata tel qu'il était avant l'ouverture (l'écriture ci-dessus ne touche que la clé de l'app).
  const choisi = choisirPlanInitial(
    tenant.metadata && typeof tenant.metadata === 'object' && !Array.isArray(tenant.metadata) ? (tenant.metadata as Record<string, unknown>) : {},
    cfg.app,
  );
  if (choisi) {
    const plan = await setAppPlan(
      db,
      {
        tenantId: tenant.id,
        app: cfg.app,
        plan: choisi.plan,
        planSource: choisi.planSource,
        reason: `création de l'espace ${cfg.app}`,
        setBy: opts.actorEmail ?? 'hub',
      },
      opts,
    ).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!plan.ok) {
      console.warn(JSON.stringify({ tag: `[${cfg.app}][plan]`, level: 'warn', tenant_id: tenant.id, error: plan.error }));
    }
  }
  return provision;
}
