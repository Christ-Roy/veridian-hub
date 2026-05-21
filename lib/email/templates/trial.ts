/**
 * Templates HTML inline pour les 3 emails de la trial state machine :
 *   - trial-started : envoyé à l'activation (J+2 après 5e mail Notifuse)
 *   - trial-ending-soon : envoyé à J+12 (3j avant expiration)
 *   - trial-expired : envoyé à J+15 si pas de CB ajoutée
 *
 * Pattern Hub existant (cf `lib/email/templates/invitation.ts`) :
 * HTML inline + `sendMail` Brevo. On ne passe PAS par Notifuse pour ces
 * mails car :
 *   1. Notifuse est l'app downstream, pas un service transactionnel Hub
 *   2. Le Hub a déjà une route Brevo en place (BREVO_API_KEY ENV)
 *   3. Cohérence : tous les autres mails Hub (invitations, MFA) passent
 *      par Brevo
 *
 * Si Robert veut basculer vers Notifuse plus tard, il suffit de remplacer
 * l'appel `sendMail(...)` côté cron par `notifuseClient.sendEmail(...)`.
 */

const HUB_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.veridian.site').replace(/\/+$/, '');

function appUrl(path: string): string {
  return `${HUB_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function shellWrap(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px; color: #111;">
  <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 40px; border: 1px solid #e5e7eb;">
    <div style="margin-bottom: 32px;">
      <span style="font-size: 20px; font-weight: 700; color: #111;">Veridian</span>
    </div>
    ${bodyHtml}
    <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 40px 0 24px;">
    <p style="color: #9ca3af; font-size: 12px; line-height: 1.6; margin: 0;">
      Vous recevez cet email parce que vous avez un workspace actif sur Veridian.
      Gérer la facturation depuis <a href="${appUrl('/dashboard/billing')}" style="color: #2563eb; text-decoration: none;">votre dashboard</a>.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TrialEmailContext {
  app: string;
  trialEndsAt: Date;
}

const APP_LABEL: Record<string, string> = {
  notifuse: 'Veridian Mail',
  prospection: 'Veridian Prospection',
  analytics: 'Veridian Analytics',
};

function appLabel(app: string): string {
  return APP_LABEL[app] ?? `Veridian ${app}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Email envoyé au moment de l'activation du trial (J+2 après l'atteinte du seuil).
 */
export function buildTrialStartedEmail(ctx: TrialEmailContext): {
  subject: string;
  html: string;
} {
  const body = `
    <h1 style="font-size: 22px; font-weight: 600; color: #111; margin: 0 0 16px;">
      Votre essai Pro vient de démarrer
    </h1>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Bonne nouvelle : vous êtes activement en train de tirer parti de
      <strong>${escapeHtml(appLabel(ctx.app))}</strong>, on vous offre donc
      les <strong>15 prochains jours en plan Pro</strong> — illimité partout,
      sans rien à faire de plus.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Le trial expire le <strong>${escapeHtml(formatDate(ctx.trialEndsAt))}</strong>.
      Si vous ajoutez une carte avant cette date, on vous offre <strong>30 jours
      supplémentaires inconditionnels</strong> en bonus (même si vous retirez
      la carte ensuite).
    </p>
    <div style="margin: 32px 0;">
      <a href="${appUrl('/dashboard/billing')}"
         style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Ajouter ma carte
      </a>
    </div>
    <p style="color: #6b7280; line-height: 1.6; margin: 0; font-size: 14px;">
      Pas envie ? Aucun souci. Pendant ces 15 jours profitez sans pression,
      on ne facture rien sans carte.
    </p>
  `;
  return {
    subject: 'Votre essai Pro Veridian vient de démarrer (15 jours)',
    html: shellWrap('Votre essai Pro Veridian vient de démarrer', body),
  };
}

/**
 * Email envoyé à J+12 (3j avant l'expiration) si pas de Stripe sub active.
 */
export function buildTrialEndingSoonEmail(ctx: TrialEmailContext): {
  subject: string;
  html: string;
} {
  const body = `
    <h1 style="font-size: 22px; font-weight: 600; color: #111; margin: 0 0 16px;">
      Plus que 3 jours sur votre essai Pro
    </h1>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Votre essai sur <strong>${escapeHtml(appLabel(ctx.app))}</strong> expire le
      <strong>${escapeHtml(formatDate(ctx.trialEndsAt))}</strong>.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Pour continuer sans interruption, ajoutez votre carte. En bonus, on vous
      offre <strong>30 jours inconditionnels supplémentaires</strong> à partir
      du moment où la carte est ajoutée — même si vous la retirez ensuite.
    </p>
    <div style="margin: 32px 0;">
      <a href="${appUrl('/dashboard/billing')}"
         style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Ajouter ma carte
      </a>
    </div>
    <p style="color: #6b7280; line-height: 1.6; margin: 0; font-size: 14px;">
      Si vous ne faites rien, votre workspace bascule en mode lecture seule.
      Vos données restent, vous pouvez réactiver à tout moment.
    </p>
  `;
  return {
    subject: 'Plus que 3 jours sur votre essai Pro Veridian',
    html: shellWrap('Plus que 3 jours sur votre essai Pro', body),
  };
}

/**
 * Email envoyé à J+15 quand le trial expire sans Stripe sub active.
 */
export function buildTrialExpiredEmail(ctx: TrialEmailContext): {
  subject: string;
  html: string;
} {
  const body = `
    <h1 style="font-size: 22px; font-weight: 600; color: #111; margin: 0 0 16px;">
      Votre essai Pro est terminé
    </h1>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Votre essai <strong>${escapeHtml(appLabel(ctx.app))}</strong> est arrivé à
      son terme. Votre workspace bascule en <strong>mode lecture seule</strong> :
      vos données restent intactes, mais l'envoi / la création de nouveau
      contenu est en pause.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Vous pouvez réactiver le plan Pro à tout moment, on remet votre workspace
      d'aplomb instantanément.
    </p>
    <div style="margin: 32px 0;">
      <a href="${appUrl('/dashboard/billing')}"
         style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Réactiver mon workspace
      </a>
    </div>
    <p style="color: #6b7280; line-height: 1.6; margin: 0; font-size: 14px;">
      Merci d'avoir testé Veridian — et n'hésitez pas à nous écrire si vous
      avez besoin d'un coup de main.
    </p>
  `;
  return {
    subject: 'Votre essai Pro Veridian est terminé',
    html: shellWrap('Votre essai Pro Veridian est terminé', body),
  };
}
