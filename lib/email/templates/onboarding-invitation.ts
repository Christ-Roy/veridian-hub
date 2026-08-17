import { escapeHtml } from '@/lib/email/templates/cross-app-invitation';

export type OnboardingInvitationEmailParams = {
  email: string;
  invitedBy: string;
  workspaceName: string;
  apps: string[];
  inviteUrl: string;
  expiresAt: Date;
};

const APP_LABELS: Record<string, string> = {
  hub: 'Hub Veridian',
  notifuse: 'Veridian Mail',
  prospection: 'Veridian Prospection',
  analytics: 'Veridian Analytics',
  cms: 'Veridian CMS',
  crm: 'Veridian CRM',
};

function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function appLabel(app: string): string {
  return APP_LABELS[app] ?? `Veridian ${app}`;
}

export function buildOnboardingInvitationEmail(params: OnboardingInvitationEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Votre accès Veridian est prêt';
  const safeInviteUrl = escapeHtml(params.inviteUrl);
  const safeWorkspace = escapeHtml(params.workspaceName);
  const safeInvitedBy = escapeHtml(params.invitedBy);
  const safeEmail = escapeHtml(params.email);
  const expires = formatDate(params.expiresAt);
  const appItems = params.apps.length > 0 ? params.apps : ['hub'];

  const appsHtml = appItems
    .map((app) => `<li style="margin:6px 0;color:#374151;">${escapeHtml(appLabel(app))}</li>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7f4;margin:0;padding:24px;color:#111827;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
    <div style="padding:28px 32px;background:#0f2e25;color:#ffffff;">
      <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">Veridian</div>
      <p style="margin:12px 0 0;color:#d7f8eb;font-size:15px;line-height:1.6;">
        Votre espace client est prêt. Il ne reste qu'à choisir votre mot de passe.
      </p>
    </div>
    <div style="padding:32px;">
      <h1 style="font-size:24px;line-height:1.25;margin:0 0 16px;color:#111827;">
        Bienvenue dans ${safeWorkspace}
      </h1>
      <p style="font-size:15px;line-height:1.7;color:#374151;margin:0 0 16px;">
        ${safeInvitedBy} vous a préparé un accès Veridian pour <strong>${safeEmail}</strong>.
        Ce lien vous permet d'activer votre compte sans mot de passe provisoire envoyé en clair.
      </p>
      <div style="background:#f0fdf7;border:1px solid #bbf7d0;border-radius:12px;padding:16px;margin:24px 0;">
        <div style="font-size:13px;font-weight:700;color:#14532d;text-transform:uppercase;letter-spacing:0.08em;">
          Vos outils
        </div>
        <ul style="padding-left:18px;margin:10px 0 0;">${appsHtml}</ul>
      </div>
      <div style="margin:28px 0;">
        <a href="${safeInviteUrl}"
           style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:700;font-size:14px;">
          Activer mon accès
        </a>
      </div>
      <p style="font-size:13px;line-height:1.6;color:#6b7280;margin:0;">
        Ce lien personnel expire le ${escapeHtml(expires)}. Si vous n'attendiez pas cet accès,
        ignorez simplement cet email.
      </p>
    </div>
  </div>
</body>
</html>`;

  const text = `Votre accès Veridian est prêt

${params.invitedBy} vous a préparé un accès à ${params.workspaceName} pour ${params.email}.

Activer mon accès : ${params.inviteUrl}

Outils : ${appItems.map(appLabel).join(', ')}

Ce lien personnel expire le ${expires}.`;

  return { subject, html, text };
}
