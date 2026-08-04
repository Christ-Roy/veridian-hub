/**
 * Résolution d'une URL d'auto-login Notifuse pour un tenant Hub.
 *
 * PROBLÈME RÉSOLU (ticket `todo/2026-07-06-autologin-cross-app-casse.md`) :
 * `/api/admin/notifuse/magic-link` exigeait `tenant.notifuseApiKey` +
 * `tenant.notifuseUserEmail`, sinon 409. Or le flow `hub link --app notifuse`
 * ne remplit PAS ces colonnes (cf `lib/admin/link-app.ts`) : un workspace
 * provisionné en direct côté Notifuse puis rattaché au Hub tombait donc
 * systématiquement sur l'écran de login de l'app. Symptôme vécu en prod
 * (démo Céline, 2026-07-06).
 *
 * STRATÉGIE — cascade de deux chemins, du moins cher au plus robuste :
 *
 *   1. `generateMagicLink` (auth par clé API tenant) — chemin nominal quand
 *      les deux colonnes sont remplies (tenant provisionné via
 *      `/api/notifuse/create-tenant`). Un seul appel réseau.
 *
 *   2. `getHealth` + `provisionWorkspace` (auth HMAC Hub) — chemin de
 *      réparation quand la clé API manque. Vérifié sur staging le
 *      2026-07-28 : `provisionWorkspace` est idempotent et renvoie un
 *      `auto_login_url` valide sur un workspace DÉJÀ existant, même s'il ne
 *      renvoie alors PAS de `api_key` (champ vide). C'est ce qui permet de
 *      réparer l'autologin sans jamais posséder la clé du tenant.
 *
 * POURQUOI `getHealth` AVANT `provisionWorkspace` : `provision` sur un
 * workspace existant avec un `owner_email` DIFFÉRENT de l'owner réel répond
 * **409** (vérifié staging). L'email stocké côté Hub peut être désynchronisé
 * (ou absent) — `getHealth` donne l'owner réel côté Notifuse, seule source de
 * vérité acceptable pour ce paramètre.
 *
 * BACKFILL OPPORTUNISTE : quand le chemin 2 réussit, on persiste ce qu'on a
 * appris (`notifuseUserEmail`, et `notifuseApiKey` si Notifuse en a renvoyé
 * une) pour que le clic suivant reprenne le chemin 1. Best-effort : un échec
 * d'écriture ne casse jamais l'ouverture de l'app, le client a déjà son lien.
 */

import type { PrismaClient } from '@prisma/client';

import { NotifuseClient } from './client';
import { NotifuseError } from './types';
import { validateWorkspaceId } from './workspace-id';

/** Chemin par lequel l'URL d'auto-login a été obtenue (observabilité + tests). */
export type AutoLoginSource = 'api_key' | 'provision_idempotent';

export type ResolveAutoLoginTenant = {
  id: string;
  notifuseWorkspaceSlug: string | null;
  notifuseApiKey: string | null;
  notifuseUserEmail: string | null;
};

export type ResolveAutoLoginSuccess = {
  ok: true;
  autoLoginUrl: string;
  /** Fallback `/console/signin?code=…` — saisie manuelle du code. */
  magicLink: string | null;
  expiresAt: string | null;
  source: AutoLoginSource;
  /** true si on a réparé les colonnes du tenant au passage. */
  backfilled: boolean;
};

export type ResolveAutoLoginFailureReason =
  /** Le tenant n'a aucun workspace Notifuse rattaché. */
  | 'not_linked'
  /** Le slug stocké ne peut pas être un workspace_id Notifuse valide. */
  | 'invalid_workspace_id'
  /** Notifuse ne connaît pas ce workspace. */
  | 'workspace_not_found'
  /** Workspace connu mais incapable de produire un magic link (owner absent…). */
  | 'not_magic_link_capable'
  /** Notifuse a répondu une erreur. */
  | 'downstream_error';

export type ResolveAutoLoginFailure = {
  ok: false;
  reason: ResolveAutoLoginFailureReason;
  message: string;
  /** Status HTTP à propager par la route appelante. */
  status: number;
};

export type ResolveAutoLoginResult =
  | ResolveAutoLoginSuccess
  | ResolveAutoLoginFailure;

export type ResolveAutoLoginDeps = {
  prisma: Pick<PrismaClient, 'tenant'>;
  client: Pick<
    NotifuseClient,
    'generateMagicLink' | 'getHealth' | 'provisionWorkspace'
  >;
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
};

export async function resolveNotifuseAutoLogin(
  tenant: ResolveAutoLoginTenant,
  { prisma, client, logger = console }: ResolveAutoLoginDeps,
): Promise<ResolveAutoLoginResult> {
  // ─── Chemin 1 : clé API tenant présente ────────────────────────────────
  if (tenant.notifuseApiKey && tenant.notifuseUserEmail) {
    try {
      const result = await client.generateMagicLink({
        apiKey: tenant.notifuseApiKey,
        userEmail: tenant.notifuseUserEmail,
      });
      return {
        ok: true,
        autoLoginUrl: result.auto_login_url,
        magicLink: result.magic_link ?? null,
        expiresAt: result.expires_at ?? null,
        source: 'api_key',
        backfilled: false,
      };
    } catch (err) {
      // Clé révoquée / workspace recréé côté Notifuse → on ne rend PAS la main
      // au client avec une erreur : on retombe sur le chemin 2, qui sait
      // réparer. C'est précisément le cas d'une désync Hub↔Notifuse.
      logger.error(
        JSON.stringify({
          tag: '[notifuse-autologin]',
          level: 'warn',
          message: 'generateMagicLink failed, falling back to provision path',
          tenantId: tenant.id,
          code: err instanceof NotifuseError ? err.code : undefined,
        }),
      );
    }
  }

  // ─── Chemin 2 : réparation via HMAC Hub ────────────────────────────────
  const workspaceId = tenant.notifuseWorkspaceSlug;
  if (!workspaceId) {
    return {
      ok: false,
      reason: 'not_linked',
      message: "Aucun workspace Notifuse n'est rattaché à ce compte.",
      status: 409,
    };
  }

  // Garde-fou : le slug stocké côté Hub accepte des hyphens et jusqu'à 120
  // chars (cf. schéma Zod de /api/admin/tenants/link-app), alors qu'un
  // workspace_id Notifuse est `[a-z0-9]{1,20}`. Sans ce test, on partirait
  // taper Notifuse avec un identifiant qui ne peut structurellement pas
  // exister, pour finir en 404 illisible.
  const slugCheck = validateWorkspaceId(workspaceId);
  if (!slugCheck.ok) {
    return {
      ok: false,
      reason: 'invalid_workspace_id',
      message: `Le workspace Notifuse rattaché ("${workspaceId}") n'est pas un identifiant valide : ${slugCheck.error}`,
      status: 409,
    };
  }

  let health;
  try {
    health = await client.getHealth(workspaceId);
  } catch (err) {
    if (err instanceof NotifuseError && err.code === 404) {
      return {
        ok: false,
        reason: 'workspace_not_found',
        message: `Notifuse ne connaît pas le workspace "${workspaceId}" rattaché à ce compte.`,
        status: 409,
      };
    }
    return {
      ok: false,
      reason: 'downstream_error',
      message: err instanceof Error ? err.message : 'Notifuse health check failed',
      status: err instanceof NotifuseError && err.code >= 400 && err.code < 600 ? err.code : 502,
    };
  }

  // `magic_link_capable` est false quand aucun owner humain n'est attaché ou
  // que le workspace est supprimé — inutile d'appeler provision, il échouera
  // ou produira un lien qui atterrit sur /console/workspace/create.
  if (!health.magic_link_capable) {
    return {
      ok: false,
      reason: 'not_magic_link_capable',
      message:
        `Le workspace Notifuse "${workspaceId}" ne peut pas produire de lien de connexion ` +
        `(owner attaché : ${health.owner_attached}, statut : ${health.status}).`,
      status: 409,
    };
  }

  // Owner réel côté Notifuse — surtout PAS l'email stocké côté Hub, qui peut
  // être désynchronisé : provision avec un owner_email divergent répond 409.
  const ownerEmail = health.owner_email ?? tenant.notifuseUserEmail;
  if (!ownerEmail) {
    return {
      ok: false,
      reason: 'not_magic_link_capable',
      message: `Le workspace Notifuse "${workspaceId}" n'a pas d'owner identifiable.`,
      status: 409,
    };
  }

  let provisioned;
  try {
    provisioned = await client.provisionWorkspace({
      tenantId: workspaceId,
      ownerEmail,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'downstream_error',
      message: err instanceof Error ? err.message : 'Notifuse provision failed',
      status: err instanceof NotifuseError && err.code >= 400 && err.code < 600 ? err.code : 502,
    };
  }

  if (!provisioned.auto_login_url) {
    return {
      ok: false,
      reason: 'downstream_error',
      message: "Notifuse n'a pas renvoyé d'URL d'auto-login.",
      status: 502,
    };
  }

  const backfilled = await backfillTenantCredentials(prisma, tenant, {
    ownerEmail,
    // Sur un workspace existant, Notifuse renvoie `api_key: ""` — on ne
    // persiste que si la valeur est réellement exploitable.
    apiKey: provisioned.api_key || null,
    logger,
  });

  return {
    ok: true,
    autoLoginUrl: provisioned.auto_login_url,
    magicLink: provisioned.magic_link ?? null,
    expiresAt: null,
    source: 'provision_idempotent',
    backfilled,
  };
}

/**
 * Persiste ce que le chemin de réparation a appris, pour que le clic suivant
 * reprenne le chemin nominal. Best-effort : jamais bloquant.
 */
async function backfillTenantCredentials(
  prisma: Pick<PrismaClient, 'tenant'>,
  tenant: ResolveAutoLoginTenant,
  params: {
    ownerEmail: string;
    apiKey: string | null;
    logger: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  },
): Promise<boolean> {
  const data: Record<string, string> = {};
  if (tenant.notifuseUserEmail !== params.ownerEmail) {
    data.notifuseUserEmail = params.ownerEmail;
  }
  if (params.apiKey && tenant.notifuseApiKey !== params.apiKey) {
    data.notifuseApiKey = params.apiKey;
  }
  if (Object.keys(data).length === 0) return false;

  try {
    await prisma.tenant.update({ where: { id: tenant.id }, data });
    params.logger.info?.(
      JSON.stringify({
        tag: '[notifuse-autologin]',
        level: 'info',
        message: 'backfilled tenant Notifuse credentials',
        tenantId: tenant.id,
        fields: Object.keys(data),
      }),
    );
    return true;
  } catch (err) {
    params.logger.error('[notifuse-autologin] backfill failed', err);
    return false;
  }
}
