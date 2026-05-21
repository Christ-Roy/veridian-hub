/**
 * Helper d'acceptation d'une invitation cross-app
 * (`hub_app.cross_app_invitations.acceptedAt` + `acceptedByUserId`).
 *
 * Appelé par `POST /api/invitations/[token]/accept` après auth user et
 * vérification token. Découpé du handler pour testabilité en isolation.
 *
 * Comportement livré (phase 4a + 4b 2026-05-21) :
 *   - Invitation marquée acceptée (transaction atomique)
 *   - Audit log écrit (best-effort en async dans le caller)
 *   - **Phase 4b** : appel HMAC opt-in vers l'app downstream (Notifuse,
 *     Prospection, Analytics, CMS) pour attacher le user au workspace.
 *     Le caller passe `attachDownstream` (factory) pour activer ce path.
 *     Si l'app downstream n'a pas encore livré son endpoint `attach-member`
 *     (404/501) ou est temporairement indisponible (timeout/5xx), le call
 *     retourne `pending` sans bloquer l'acceptation côté Hub — l'UI peut
 *     proposer un retry.
 *   - Si downstream renvoie 200/201 : on collecte le `loginUrl` retourné
 *     pour redirect auto-login après acceptation.
 *
 * Le caller décide du status HTTP à renvoyer :
 *   - `downstreamCall='completed'` → 200 OK + `redirect_url=loginUrl`
 *   - `downstreamCall='pending'`   → 202 Accepted (idem)
 *   - `downstreamCall='error'`     → 502 Bad Gateway (erreur business
 *     downstream identifiée, ex: workspace suspended). L'invitation
 *     reste acceptée côté Hub pour audit, mais l'UI signale l'erreur.
 */

import type { PrismaClient, CrossAppInvitation } from '@prisma/client';

import type {
  AttachDownstreamInput,
  AttachDownstreamResult,
} from './attach-downstream';

export type AttachDownstreamFn = (
  input: AttachDownstreamInput,
) => Promise<AttachDownstreamResult>;

export type AcceptInvitationInput = {
  token: string;
  acceptingUserId: string;
  acceptingUserEmail: string;
  /** Si true, accepte même si l'email du user loggué ne matche pas
   *  `invitee_email` (cas warning UI : l'user décide de continuer avec
   *  son compte actuel au lieu de logout). */
  allowEmailMismatch?: boolean;
  now?: () => Date;
  /** Optionnel — fonction d'attach downstream (HMAC vers l'app cible).
   *  Si absent, le helper se comporte comme en phase 4a : `downstreamCall='pending'`
   *  sans tenter d'appel réseau. C'est l'opt-in pour activer la phase 4b
   *  (le caller injecte `attachMemberDownstream` du module dédié).
   *  Pattern d'injection volontaire pour découpler le helper du module
   *  réseau et garder la testabilité unitaire (cf accept.test.ts). */
  attachDownstream?: AttachDownstreamFn;
};

export type AcceptInvitationOk = {
  ok: true;
  invitation: CrossAppInvitation;
  emailMismatch: boolean;
  /** Statut de la propagation à l'app downstream :
   *   - `completed` : attach-member a répondu 200/201, accès cross-app actif.
   *   - `pending`   : endpoint downstream absent (404/501), timeout, ou
   *     5xx — le user peut retry, l'invitation reste acceptée côté Hub.
   *   - `error`     : downstream a remonté une erreur 4xx business (ex: 423
   *     workspace_suspended, 409 user_role_conflict). L'UI doit l'afficher. */
  downstreamCall: 'pending' | 'completed' | 'error';
  /** Présent si `downstreamCall='completed'` : URL d'auto-login retournée
   *  par l'app downstream pour rediriger immédiatement le user. Peut être
   *  null si downstream n'en a pas généré. */
  downstreamLoginUrl?: string | null;
  /** Présent si `downstreamCall='error'` : code business remonté par l'app
   *  downstream pour affichage UI (ex: 'workspace_suspended'). */
  downstreamErrorCode?: string | null;
  /** Présent si `downstreamCall='error'` : status HTTP du downstream. */
  downstreamHttpStatus?: number | null;
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

  // Phase A : transaction atomique pour le state DB (lookup + update).
  // On EXÉCUTE l'appel downstream APRÈS la transaction — sinon on garde la
  // connexion DB ouverte pendant un round-trip HTTP, ce qui peut épuiser
  // le pool sur un downstream lent et de toute façon ne nous protégerait
  // pas (le call downstream ne participe pas à la transaction Prisma).
  const txResult = await prisma.$transaction(async (tx) => {
    const invitation = await tx.crossAppInvitation.findUnique({
      where: { token: input.token },
    });

    if (!invitation) {
      return { kind: 'fail' as const, code: 'not_found' as const };
    }

    if (invitation.acceptedAt) {
      return {
        kind: 'fail' as const,
        code: 'already_accepted' as const,
        acceptedByUserId: invitation.acceptedByUserId ?? undefined,
      };
    }

    if (invitation.expiresAt <= now) {
      return { kind: 'fail' as const, code: 'expired' as const };
    }

    const emailMismatch =
      invitation.inviteeEmail.trim().toLowerCase() !==
      input.acceptingUserEmail.trim().toLowerCase();

    if (emailMismatch && !input.allowEmailMismatch) {
      return { kind: 'fail' as const, code: 'email_mismatch' as const };
    }

    const updated = await tx.crossAppInvitation.update({
      where: { id: invitation.id },
      data: {
        acceptedAt: now,
        acceptedByUserId: input.acceptingUserId,
      },
    });

    return {
      kind: 'ok' as const,
      invitation: updated,
      emailMismatch,
    };
  });

  if (txResult.kind === 'fail') {
    const fail: AcceptInvitationFail = {
      ok: false,
      code: txResult.code,
      acceptedByUserId: txResult.acceptedByUserId,
    };
    return fail;
  }

  // Phase B (4b) : propagation vers l'app downstream (HMAC), si le caller
  // a injecté la fonction d'attach. Si absent → comportement legacy 4a :
  // downstream='pending' sans tenter d'appel réseau (utile pour les tests
  // qui isolent juste la logique DB).
  if (!input.attachDownstream) {
    return {
      ok: true,
      invitation: txResult.invitation,
      emailMismatch: txResult.emailMismatch,
      downstreamCall: 'pending',
      downstreamLoginUrl: null,
    };
  }

  const inv = txResult.invitation;
  // SUPPORTED_APPS dans hmac.ts définit les apps valides — un targetApp
  // sortant de cette liste ne devrait pas exister vu le check Zod côté
  // create, mais on garde une garde défensive.
  const targetApp = inv.targetApp as
    | 'notifuse'
    | 'prospection'
    | 'analytics'
    | 'cms';

  let attachResult: AttachDownstreamResult;
  try {
    attachResult = await input.attachDownstream({
      targetApp,
      targetWorkspaceId: inv.targetWorkspaceId,
      hubUserId: input.acceptingUserId,
      hubUserEmail: input.acceptingUserEmail,
      role: inv.targetRole,
      invitationId: inv.id,
    });
  } catch (err) {
    // Le module attach-downstream ne THROW PAS normalement — tout est mappé
    // en union type. Mais si une erreur de programmation se glisse, on
    // dégrade en pending plutôt que d'écraser l'acceptation côté Hub.
    console.error(
      JSON.stringify({
        tag: '[invitations][accept][attach-downstream][unexpected-throw]',
        level: 'error',
        error: err instanceof Error ? err.message : String(err),
        invitation_id: inv.id,
        target_app: targetApp,
        ts: new Date().toISOString(),
      }),
    );
    return {
      ok: true,
      invitation: inv,
      emailMismatch: txResult.emailMismatch,
      downstreamCall: 'pending',
      downstreamLoginUrl: null,
    };
  }

  if (attachResult.status === 'completed') {
    return {
      ok: true,
      invitation: inv,
      emailMismatch: txResult.emailMismatch,
      downstreamCall: 'completed',
      downstreamLoginUrl: attachResult.loginUrl,
    };
  }

  if (attachResult.status === 'error') {
    return {
      ok: true,
      invitation: inv,
      emailMismatch: txResult.emailMismatch,
      downstreamCall: 'error',
      downstreamErrorCode: attachResult.errorCode,
      downstreamHttpStatus: attachResult.httpStatus,
    };
  }

  // pending
  return {
    ok: true,
    invitation: inv,
    emailMismatch: txResult.emailMismatch,
    downstreamCall: 'pending',
    downstreamLoginUrl: null,
  };
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
