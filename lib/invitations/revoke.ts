/**
 * Helper de révocation d'invitation cross-app.
 *
 * Pas un vrai DELETE SQL : on force `expiresAt = now` pour invalider
 * l'invitation tout en gardant la row en DB. Permet :
 *   - audit forensics ("qui a invité qui, et révoqué quand")
 *   - empêcher la réutilisation du token côté /accept (expired)
 *   - éviter les écueils de FK cascade si on ajoute des refs dans le futur
 *
 * Sécurité : l'autorisation (inviter == session user) est faite côté route,
 * pas ici. Ce helper est "trusted" — il assume que la vérif a été faite.
 */

import type { PrismaClient, CrossAppInvitation } from '@prisma/client';

export type RevokeInvitationInput = {
  invitationId: string;
  /** Pour double-check côté helper : ne révoque que si l'inviter matche.
   *  Défense en profondeur si la route oublie de vérifier. */
  expectedInviterUserId: string;
  now?: () => Date;
};

export type RevokeInvitationResult =
  | {
      ok: true;
      invitation: CrossAppInvitation;
      /** true = l'invitation était déjà expirée ou acceptée (no-op effectif) */
      alreadyInactive: boolean;
    }
  | {
      ok: false;
      code: 'not_found' | 'forbidden' | 'already_accepted';
    };

export async function revokeCrossAppInvitation(
  prisma: PrismaClient,
  input: RevokeInvitationInput,
): Promise<RevokeInvitationResult> {
  const now = (input.now ?? (() => new Date()))();

  return await prisma.$transaction(async (tx) => {
    const invitation = await tx.crossAppInvitation.findUnique({
      where: { id: input.invitationId },
    });

    if (!invitation) {
      return { ok: false, code: 'not_found' };
    }

    if (invitation.inviterUserId !== input.expectedInviterUserId) {
      // 403 — l'inviter ne matche pas l'user loggué. On ne fuite pas
      // l'info "elle existe mais tu n'es pas le proprio" → caller peut
      // mapper sur 404 si paranoïaque, mais ici on signale 403 pour aider
      // au debug (la route fera l'arbitrage).
      return { ok: false, code: 'forbidden' };
    }

    if (invitation.acceptedAt) {
      // Pas révocable — l'user a déjà rejoint le workspace. Le caller
      // doit passer par l'app downstream pour le retirer.
      return { ok: false, code: 'already_accepted' };
    }

    const alreadyInactive = invitation.expiresAt <= now;

    if (alreadyInactive) {
      // No-op (déjà expirée), pas besoin d'update DB
      return { ok: true, invitation, alreadyInactive: true };
    }

    const updated = await tx.crossAppInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: now },
    });

    return { ok: true, invitation: updated, alreadyInactive: false };
  });
}
