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
      Vous recevez ce message parce que vous avez un espace actif sur Veridian.
      Gérez votre abonnement depuis <a href="${appUrl('/dashboard/billing')}" style="color: #2563eb; text-decoration: none;">votre espace</a>.
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
 * Mails de la machine d'essai, réécrits le 08/11 : ils annonçaient une lecture seule et un bonus de
 * 30 jours que rien n'applique. Ils disent ce qui arrive vraiment : à la fin, retour au plan gratuit,
 * rien de bloqué, aucun débit. Vouvoiement, aucun tiret cadratin entouré d'espaces, signés Robert.
 * `__tests__/lib/email/templates/trial.test.ts` échoue si une promesse non codée revient.
 */
const SIGNATURE = `
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Robert Brunon<br>Veridian
    </p>`;

/**
 * Email envoyé au moment de l'activation du trial (J+2 après l'atteinte du seuil).
 */
export function buildTrialStartedEmail(ctx: TrialEmailContext): {
  subject: string;
  html: string;
} {
  const body = `
    <h1 style="font-size: 22px; font-weight: 600; color: #111; margin: 0 0 16px;">
      Votre essai Pro démarre aujourd'hui
    </h1>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Vous utilisez activement <strong>${escapeHtml(appLabel(ctx.app))}</strong> : nous vous offrons les
      <strong>15 prochains jours en plan Pro</strong>, sans rien à faire de votre côté.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Votre essai se termine le <strong>${escapeHtml(formatDate(ctx.trialEndsAt))}</strong>. Ensuite, votre
      espace revient au plan gratuit : vos données restent en place, rien n'est bloqué et rien ne vous est facturé.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Si vous souhaitez garder le plan Pro après cette date, vous pourrez ajouter une carte depuis votre espace.
    </p>
    <div style="margin: 32px 0;">
      <a href="${appUrl('/dashboard/billing')}"
         style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Voir les formules
      </a>
    </div>${SIGNATURE}
  `;

  return {
    subject: 'Votre essai Pro Veridian démarre aujourd\'hui (15 jours)',
    html: shellWrap('Votre essai Pro Veridian démarre aujourd\'hui', body),
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
      Plus que 3 jours d'essai Pro
    </h1>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Votre essai Pro sur <strong>${escapeHtml(appLabel(ctx.app))}</strong> se termine le
      <strong>${escapeHtml(formatDate(ctx.trialEndsAt))}</strong>.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      À cette date, votre espace revient au plan gratuit. Vos données restent en place, rien n'est bloqué
      et aucun débit n'a lieu.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Pour garder le plan Pro, vous pouvez ajouter une carte depuis votre espace.
    </p>
    <div style="margin: 32px 0;">
      <a href="${appUrl('/dashboard/billing')}"
         style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Garder le plan Pro
      </a>
    </div>${SIGNATURE}
  `;

  return {
    subject: 'Votre essai Pro Veridian se termine dans 3 jours',
    html: shellWrap('Votre essai Pro Veridian se termine dans 3 jours', body),
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
      Votre essai Pro sur <strong>${escapeHtml(appLabel(ctx.app))}</strong> est arrivé à son terme : votre
      espace est revenu au plan gratuit.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Vos données sont intactes et vous continuez à utiliser ${escapeHtml(appLabel(ctx.app))} comme avant.
      Rien ne vous a été facturé.
    </p>
    <p style="color: #374151; line-height: 1.6; margin: 0 0 16px;">
      Si vous souhaitez repasser au plan Pro, c'est possible à tout moment depuis votre espace.
    </p>
    <div style="margin: 32px 0;">
      <a href="${appUrl('/dashboard/billing')}"
         style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        Voir les formules
      </a>
    </div>
    <p style="color: #6b7280; line-height: 1.6; margin: 0 0 16px; font-size: 14px;">
      Une question ? Écrivez-nous à contact@veridian.site.
    </p>${SIGNATURE}
  `;

  return {
    subject: 'Votre essai Pro Veridian est terminé',
    html: shellWrap('Votre essai Pro Veridian est terminé', body),
  };
}
