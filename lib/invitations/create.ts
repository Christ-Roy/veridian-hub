/**
 * Helpers de création d'invitations cross-app (`hub_app.cross_app_invitations`).
 *
 * Appelé par `POST /api/invitations/create` après auth HMAC et validation Zod.
 * Découpé du handler de route pour pouvoir être testé en isolation (mock Prisma)
 * et réutilisé depuis d'autres callers (skill agent IA, cron de re-invitation).
 *
 * Idempotence :
 *   - Si une invitation pending (acceptedAt=null, expiresAt>now) existe déjà
 *     pour le couple (invitee_email, target_app, target_workspace_id), on
 *     retourne l'existante au lieu d'en créer une nouvelle.
 *   - Évite le spam si l'app downstream re-clique "Inviter" (idempotence
 *     naturelle côté Hub, l'app downstream n'a pas à gérer ce cas).
 *
 * Token :
 *   - 32 bytes random → 64 chars hex. Espace ~10^77, brute-force infaisable.
 *   - Stocké en clair côté DB (lookup chaud sur `verify/accept`, l'index
 *     unique `token` suffit comme garde).
 */

import { randomBytes } from 'node:crypto';
import { tenantDeLInvitation } from '@/lib/invitations/jonction';
import type { PrismaClient, CrossAppInvitation } from '@prisma/client';

const DEFAULT_EXPIRY_DAYS = 7;
const VALID_TARGET_APPS = ['notifuse', 'prospection', 'analytics', 'cms'] as const;
const VALID_ROLES = ['owner', 'admin', 'member'] as const;

export type TargetApp = (typeof VALID_TARGET_APPS)[number];
export type TargetRole = (typeof VALID_ROLES)[number];

export type CreateInvitationInput = {
  inviterUserId: string;
  inviterEmail: string;
  inviteeEmail: string;
  targetApp: TargetApp;
  targetWorkspaceId: string;
  targetRole?: TargetRole;
  message?: string;
  /** Override expiry (jours). Défaut 7. Tests peuvent fixer 1 jour pour
   *  vérifier le flow d'expiration. */
  expiryDays?: number;
  /** Override token generator (tests). */
  generateToken?: () => string;
  /** Override now() (tests deterministic). */
  now?: () => Date;
};

export type CreateInvitationResult = {
  invitation: CrossAppInvitation;
  /** true = invitation déjà existante réutilisée (idempotence) */
  reused: boolean;
};

export class InvitationCreateError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_target_app'
      | 'invalid_target_role'
      | 'inviter_not_found'
      | 'self_invitation'
      | 'quota_exceeded'
      | 'espace_non_relie'
      | 'inviteur_non_habilite'
      | 'echec',
  ) {
    super(message);
    this.name = 'InvitationCreateError';
  }
}

const MESSAGES = {
  espace_non_relie: "Cet espace n'est relié à aucune organisation Veridian : personne ne peut y être invité. Le relier depuis le Hub, puis réessayer.",
  inviteur_non_habilite: "Seul un propriétaire ou un admin de l'organisation, au Hub, peut inviter.",
  echec: "Le Hub n'a pas pu vérifier cet espace : réessayer dans un instant.",
} as const;

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Invitations créées par espace et par 24 h. */
export const INVITATIONS_PAR_JOUR = 20;

export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

export function buildMagicLinkUrl(token: string, siteUrl?: string): string {
  // Pas de fallback "hardcoded" en prod — on prend l'env config explicite.
  // En tests ce paramètre est passé directement (pas de dépendance env).
  const base = (siteUrl ?? process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  if (!base) {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL not configured — required to build invitation magic link',
    );
  }
  return `${base}/invite/${token}`;
}

export async function createCrossAppInvitation(
  prisma: PrismaClient,
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  // Sanity checks runtime — même si Zod en amont, helper reste sûr en standalone.
  if (!VALID_TARGET_APPS.includes(input.targetApp)) {
    throw new InvitationCreateError(
      `target_app must be one of ${VALID_TARGET_APPS.join(', ')}`,
      'invalid_target_app',
    );
  }
  const role = input.targetRole ?? 'member';
  if (!VALID_ROLES.includes(role)) {
    throw new InvitationCreateError(
      `target_role must be one of ${VALID_ROLES.join(', ')}`,
      'invalid_target_role',
    );
  }

  // Anti self-invitation : un user qui s'invite lui-même au workspace dont
  // il est déjà owner = nonsense, et si jamais accepté ça crée une boucle
  // côté app downstream (l'attach ne fait rien mais le hit DB est pollution).
  if (
    input.inviterEmail.trim().toLowerCase() ===
    input.inviteeEmail.trim().toLowerCase()
  ) {
    throw new InvitationCreateError(
      'Cannot invite yourself',
      'self_invitation',
    );
  }

  // Vérif inviter_user_id existe en DB — sinon FK violation au CREATE,
  // mais on préfère lever une erreur explicite plutôt qu'une 500 SQL.
  // Les apps ne connaissent que hub_user_id (= supabaseUserId, un uuid) ; users.id reste admis (24/11 : 404 pour tout propriétaire).
  const selection = { id: true, email: true } as const;
  const parHubUserId = UUID.test(input.inviterUserId) ? await prisma.user.findFirst({ where: { supabaseUserId: input.inviterUserId }, select: selection }) : null;
  const inviter = parHubUserId ?? (await prisma.user.findUnique({ where: { id: input.inviterUserId }, select: selection }));
  if (!inviter) {
    throw new InvitationCreateError(
      `Inviter user ${input.inviterUserId} not found in hub_app.users`,
      'inviter_not_found',
    );
  }

  // Un espace que le Hub ne relie pas donnerait un membre qu'il ne pourrait pas couper : refusé dès la création (VER-245).
  const v = await tenantDeLInvitation(prisma, { inviterUserId: inviter.id, targetApp: input.targetApp, targetWorkspaceId: input.targetWorkspaceId });
  if (v.refus) throw new InvitationCreateError(MESSAGES[v.refus], v.refus);

  const now = (input.now ?? (() => new Date()))();

  // Idempotence : pending = acceptedAt null ET non expirée.
  const existing = await prisma.crossAppInvitation.findFirst({
    where: {
      inviteeEmail: input.inviteeEmail,
      targetApp: input.targetApp,
      targetWorkspaceId: input.targetWorkspaceId,
      acceptedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (existing) {
    return { invitation: existing, reused: true };
  }

  // Plafond par espace et par jour (VER-245) : une app compromise n'ouvre pas un espace à cent inconnus en une nuit.
  const duJour = await prisma.crossAppInvitation.count({
    where: { targetApp: input.targetApp, targetWorkspaceId: input.targetWorkspaceId, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
  if (duJour >= INVITATIONS_PAR_JOUR) throw new InvitationCreateError(`${INVITATIONS_PAR_JOUR} invitations par jour et par espace au plus`, 'quota_exceeded');

  const expiryDays = input.expiryDays ?? DEFAULT_EXPIRY_DAYS;
  const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
  const token = (input.generateToken ?? generateInvitationToken)();

  const created = await prisma.crossAppInvitation.create({
    data: {
      token,
      inviterUserId: inviter.id,
      inviterEmail: input.inviterEmail,
      inviteeEmail: input.inviteeEmail,
      targetApp: input.targetApp,
      targetWorkspaceId: input.targetWorkspaceId,
      targetRole: role,
      message: input.message ?? null,
      expiresAt,
    },
  });

  return { invitation: created, reused: false };
}

// Export internals for testability.
export const __invitationConstants = {
  VALID_TARGET_APPS,
  VALID_ROLES,
  DEFAULT_EXPIRY_DAYS,
};
