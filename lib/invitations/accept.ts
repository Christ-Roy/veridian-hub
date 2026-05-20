/**
 * Helper d'acceptation d'une invitation cross-app
 * (`hub_app.cross_app_invitations.acceptedAt` + `acceptedByUserId`).
 *
 * Appelé par `POST /api/invitations/[token]/accept` après auth user et
 * vérification token. Découpé du handler pour testabilité en isolation.
 *
 * État final livré par cet helper :
 *   - Invitation marquée acceptée (transaction atomique)
 *   - Audit log écrit (best-effort en async dans le caller)
 *
 * État NON encore livré (TODO P1-step4b — quand apps downstream ont leur
 * endpoint attach-member) :
 *   - Appel HMAC vers l'app downstream pour attacher le user au workspace
 *   - Pour l'instant le helper retourne `downstreamCall: 'pending'` pour
 *     que le caller renvoie 202 Accepted (action enregistrée côté Hub
 *     mais pas encore propagée à l'app cible).
 */

import type { PrismaClient, CrossAppInvitation } from '@prisma/client';

export type AcceptInvitationInput = {
  token: string;
  acceptingUserId: string;
  acceptingUserEmail: string;
  /** Si true, accepte même si l'email du user loggué ne matche pas
   *  `invitee_email` (cas warning UI : l'user décide de continuer avec
   *  son compte actuel au lieu de logout). */
  allowEmailMismatch?: boolean;
  now?: () => Date;
};

export type AcceptInvitationOk = {
  ok: true;
  invitation: CrossAppInvitation;
  emailMismatch: boolean;
  /** 'pending' tant que la phase 4b n'est pas livrée (call downstream). */
  downstreamCall: 'pending' | 'completed';
};

export type AcceptInvitationFail = {
  ok: false;
  code:
    | 'not_found'
    | 'expired'
    | 'already_accepted'
    | 'email_mismatch'
    | 'invalid_token_format';
  /** Pour `already_accepted` : qui l'a acceptée (peut être == acceptingUserId
   *  si l'user double-click ; informational). */
  acceptedByUserId?: string;
};

export type AcceptInvitationResult = AcceptInvitationOk | AcceptInvitationFail;

const TOKEN_FORMAT = /^[0-9a-f]{64}$/;

export async function acceptCrossAppInvitation(
  prisma: PrismaClient,
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  if (!TOKEN_FORMAT.test(input.token)) {
    return { ok: false, code: 'invalid_token_format' };
  }

  const now = (input.now ?? (() => new Date()))();

  // On exécute lookup + update dans une transaction atomique pour éviter la
  // race condition "deux clicks simultanés" → la 2e tentative voit l'état
  // post-update et retourne `already_accepted` avec acceptedByUserId du 1er.
  return await prisma.$transaction(async (tx) => {
    const invitation = await tx.crossAppInvitation.findUnique({
      where: { token: input.token },
    });

    if (!invitation) {
      return { ok: false, code: 'not_found' };
    }

    if (invitation.acceptedAt) {
      return {
        ok: false,
        code: 'already_accepted',
        acceptedByUserId: invitation.acceptedByUserId ?? undefined,
      };
    }

    if (invitation.expiresAt <= now) {
      return { ok: false, code: 'expired' };
    }

    const emailMismatch =
      invitation.inviteeEmail.trim().toLowerCase() !==
      input.acceptingUserEmail.trim().toLowerCase();

    if (emailMismatch && !input.allowEmailMismatch) {
      return { ok: false, code: 'email_mismatch' };
    }

    const updated = await tx.crossAppInvitation.update({
      where: { id: invitation.id },
      data: {
        acceptedAt: now,
        acceptedByUserId: input.acceptingUserId,
      },
    });

    return {
      ok: true,
      invitation: updated,
      emailMismatch,
      // TODO(P1-step4b) — câbler l'appel HMAC vers l'app downstream
      // (Notifuse/Prospection/Analytics/CMS) pour attacher acceptingUserId
      // au workspace `invitation.targetWorkspaceId` avec rôle
      // `invitation.targetRole`. Pour l'instant on enregistre l'acceptation
      // côté Hub uniquement → le caller renvoie 202 Accepted (pas 200).
      downstreamCall: 'pending',
    };
  });
}

/**
 * Construit l'URL de redirection vers l'app downstream après acceptation.
 * Pour l'instant retourne juste l'URL racine de l'app (au mieux). Phase 4b
 * remplacera par un magic-link auto-login signé HMAC.
 */
export function buildPostAcceptRedirectUrl(
  targetApp: CrossAppInvitation['targetApp'],
  envOverride?: NodeJS.ProcessEnv,
): string {
  const env = envOverride ?? process.env;
  const baseByApp: Record<string, string | undefined> = {
    notifuse: env.NEXT_PUBLIC_NOTIFUSE_URL,
    prospection: env.NEXT_PUBLIC_PROSPECTION_URL,
    analytics: env.NEXT_PUBLIC_ANALYTICS_URL,
    cms: env.NEXT_PUBLIC_CMS_URL,
  };
  const url = baseByApp[targetApp];
  if (url && url.length > 0) {
    return url.replace(/\/$/, '');
  }
  // Fallback : convention `<targetApp>.app.veridian.site`
  return `https://${targetApp}.app.veridian.site`;
}
