// Template email invitation workspace — P1.5

export function buildInvitationEmail(params: {
  inviterName: string;
  workspaceName: string;
  role: string;
  inviteUrl: string;
  expiresAt: Date;
}): string {
  const expiresFormatted = params.expiresAt.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
  <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 40px; border: 1px solid #e5e7eb;">
    <div style="margin-bottom: 32px;">
      <span style="font-size: 20px; font-weight: 700; color: #111;">Veridian</span>
    </div>

    <h1 style="font-size: 22px; font-weight: 600; color: #111; margin: 0 0 16px;">
      Vous avez été invité dans ${params.workspaceName}
    </h1>

    <p style="color: #6b7280; line-height: 1.6; margin: 0 0 16px;">
      <strong style="color: #111;">${params.inviterName}</strong> vous invite à rejoindre le workspace
      <strong style="color: #111;">${params.workspaceName}</strong> en tant que
      <strong style="color: #111;">${params.role}</strong>.
    </p>

    <div style="margin: 32px 0;">
      <a href="${params.inviteUrl}"
         style="display: inline-block; background: #111; color: #fff; text-decoration: none;
                padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px;">
        Accepter l'invitation
      </a>
    </div>

    <p style="color: #9ca3af; font-size: 13px; margin: 0;">
      Ce lien expire le ${expiresFormatted}. Si vous n'attendiez pas cette invitation, ignorez cet email.
    </p>
  </div>
</body>
</html>
  `.trim();
}
