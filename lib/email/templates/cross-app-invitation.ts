/**
 * Template HTML "Invitation cross-app Veridian" (livrable 4 sprint v1.4).
 *
 * Email envoyé quand une app downstream (Notifuse, Prospection, Analytics,
 * CMS) crée une invitation via `POST /api/invitations/create`. Le Hub
 * envoie l'email au lieu de laisser chaque app gérer ses propres
 * templates : 1 design unifié, 1 source de vérité, 1 point de rotation.
 *
 * Direction artistique Veridian :
 *   - vert primary  #6DD5B0  (CTA, accents)
 *   - vert foncé    #1A4D3A  (titres)
 *   - bg clair      #F0FDF7
 *   - bg footer     #F9FAFB
 *   - texte         #374151
 *   - texte footer  #9CA3AF
 *
 * Pour les emails transactionnels, on génère du HTML inline (pas de
 * dépendance mjml runtime ni de pré-compilation). Pattern aligné avec
 * `lib/email/templates/invitation.ts` (workspace internal) pour cohérence.
 *
 * Le template inclut :
 *   - Header logo Veridian + nom de l'inviteur
 *   - Body "Vous avez été invité par X à rejoindre <app>"
 *   - CTA "Accepter l'invitation" → URL /invite/[token]
 *   - Message optionnel libre laissé par l'inviteur
 *   - Footer mentions légales + lien désinscription
 *
 * Sécurité :
 *   - Tous les inputs utilisateur (inviterName, message, etc.) sont
 *     échappés HTML pour empêcher l'injection. Le caller passe les
 *     valeurs brutes, le template échappe.
 *   - Le message est aussi tronqué côté Zod (500 chars max) et bloque
 *     les caractères de contrôle / `<` `>` côté route (cf
 *     `app/api/invitations/create/route.ts`).
 */

type TargetApp = 'notifuse' | 'prospection' | 'analytics' | 'cms';

const APP_DISPLAY_NAME: Record<TargetApp, string> = {
  notifuse: 'Notifuse',
  prospection: 'Prospection',
  analytics: 'Analytics',
  cms: 'CMS',
};

const APP_TAGLINE: Record<TargetApp, string> = {
  notifuse: 'la plateforme d\'emails transactionnels Veridian',
  prospection: 'l\'outil de prospection commerciale Veridian',
  analytics: 'le service d\'analytics web Veridian',
  cms: 'le CMS multi-tenant Veridian',
};

const ROLE_LABEL: Record<string, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: 'Membre',
};

/** Échappe les caractères HTML dangereux dans une string libre. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CrossAppInvitationEmailParams {
  inviterName: string;
  inviterEmail: string;
  inviteeEmail: string;
  targetApp: TargetApp;
  targetRole: string;
  inviteUrl: string;
  expiresAt: Date;
  message?: string | null;
  /** Override pour test : URL de désinscription Notifuse / centre de
   *  préférences. En prod : `${NEXT_PUBLIC_SITE_URL}/unsubscribe?email=...`
   *  ou centre de préf cross-app. Défaut : mail to support. */
  unsubscribeUrl?: string;
}

export interface CrossAppInvitationEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildCrossAppInvitationEmail(
  params: CrossAppInvitationEmailParams,
): CrossAppInvitationEmail {
  const appName = APP_DISPLAY_NAME[params.targetApp];
  const appTagline = APP_TAGLINE[params.targetApp];
  const roleLabel = ROLE_LABEL[params.targetRole.toLowerCase()] ?? params.targetRole;
  const expires = params.expiresAt.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const safeInviterName = escapeHtml(params.inviterName);
  const safeInviterEmail = escapeHtml(params.inviterEmail);
  const safeAppName = escapeHtml(appName);
  const safeAppTagline = escapeHtml(appTagline);
  const safeRole = escapeHtml(roleLabel);
  const safeInviteUrl = escapeHtml(params.inviteUrl);
  const safeMessage = params.message ? escapeHtml(params.message) : null;
  const unsubscribeUrl =
    params.unsubscribeUrl ?? 'mailto:support@veridian.site?subject=Désinscription';
  const safeUnsubscribeUrl = escapeHtml(unsubscribeUrl);

  const subject = `${params.inviterName} vous invite sur ${appName} (Veridian)`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="font-family: 'Segoe UI', Arial, Helvetica, sans-serif; background: #F0FDF7; margin: 0; padding: 24px; color: #374151;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; margin: 0 auto;">
    <!-- Header logo Veridian -->
    <tr>
      <td style="padding: 24px 0; text-align: center;">
        <img src="https://veridian.site/icon.svg" alt="Veridian" width="48" height="48" style="display: inline-block;">
        <div style="margin-top: 8px; font-size: 14px; color: #6B7280; letter-spacing: 0.5px;">VERIDIAN</div>
      </td>
    </tr>

    <!-- Card principale -->
    <tr>
      <td style="background: #ffffff; border-radius: 12px; padding: 40px; border: 1px solid #E5E7EB;">
        <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: #1A4D3A; line-height: 1.3;">
          Vous avez été invité sur ${safeAppName}
        </h1>

        <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.6; color: #374151;">
          <strong style="color: #1A4D3A;">${safeInviterName}</strong>
          (${safeInviterEmail}) vous invite à rejoindre
          <strong style="color: #1A4D3A;">${safeAppName}</strong>,
          ${safeAppTagline}, en tant que
          <strong style="color: #1A4D3A;">${safeRole}</strong>.
        </p>

        ${
          safeMessage
            ? `<div style="margin: 20px 0; padding: 16px 20px; background: #F0FDF7; border-left: 3px solid #6DD5B0; border-radius: 4px;">
                <div style="font-size: 13px; font-weight: 600; color: #1A4D3A; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Message de ${safeInviterName}</div>
                <div style="font-size: 15px; color: #374151; line-height: 1.5; white-space: pre-wrap;">${safeMessage}</div>
              </div>`
            : ''
        }

        <!-- CTA -->
        <div style="margin: 32px 0 24px; text-align: center;">
          <a href="${safeInviteUrl}"
             style="display: inline-block; background: #6DD5B0; color: #1A4D3A; text-decoration: none;
                    padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 15px;
                    box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
            Accepter l'invitation
          </a>
        </div>

        <p style="margin: 24px 0 0; font-size: 13px; color: #9CA3AF; line-height: 1.5; text-align: center;">
          Ce lien expire le <strong>${expires}</strong>.<br>
          Si vous n'attendiez pas cette invitation, ignorez cet email.
        </p>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding: 32px 24px 16px; text-align: center;">
        <p style="margin: 0 0 8px; font-size: 12px; color: #9CA3AF;">
          Cet email vous a été envoyé par Veridian car ${safeInviterName}
          vous a explicitement invité sur l'un de nos services.
        </p>
        <p style="margin: 0 0 8px; font-size: 12px; color: #9CA3AF;">
          <a href="https://veridian.site" style="color: #6B7280; text-decoration: underline;">veridian.site</a>
          &middot;
          <a href="${safeUnsubscribeUrl}" style="color: #6B7280; text-decoration: underline;">Se désinscrire</a>
          &middot;
          <a href="https://veridian.site/legal" style="color: #6B7280; text-decoration: underline;">Mentions légales</a>
        </p>
        <p style="margin: 8px 0 0; font-size: 11px; color: #9CA3AF;">
          &copy; 2026 Veridian. Tous droits réservés.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const text = [
    `${params.inviterName} (${params.inviterEmail}) vous invite à rejoindre ${appName}, ${appTagline}, en tant que ${roleLabel}.`,
    '',
    params.message ? `Message : ${params.message}` : '',
    '',
    `Accepter l'invitation : ${params.inviteUrl}`,
    '',
    `Ce lien expire le ${expires}. Si vous n'attendiez pas cette invitation, ignorez cet email.`,
    '',
    '---',
    'Veridian — https://veridian.site',
    `Se désinscrire : ${unsubscribeUrl}`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  return { subject, html, text };
}

export const __crossAppInvitationConstants = {
  APP_DISPLAY_NAME,
  APP_TAGLINE,
  ROLE_LABEL,
};
