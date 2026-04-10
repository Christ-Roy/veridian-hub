// Template HTML inline pour l'email "Code de connexion Veridian".
// On ne passe pas par un template Brevo distant pour garder le contrôle dans
// le code et éviter de dépendre d'un template_id versionné à la main.

export type MfaCodeTemplateVars = {
  code: string;
  expiresInMinutes: number;
};

export function renderMfaCodeEmail({ code, expiresInMinutes }: MfaCodeTemplateVars): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Code de connexion Veridian';

  const html = `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f8fa;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
            <tr>
              <td style="padding-bottom:24px;">
                <div style="font-size:20px;font-weight:600;color:#0f172a;">Veridian</div>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:16px;font-size:18px;font-weight:600;color:#0f172a;">
                Code de connexion
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px;font-size:14px;line-height:22px;color:#475569;">
                Une nouvelle connexion à votre compte Veridian a été demandée. Utilisez le code ci-dessous pour confirmer qu'il s'agit bien de vous.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <div style="display:inline-block;padding:16px 24px;background:#f1f5f9;border-radius:8px;font-size:28px;font-weight:700;letter-spacing:8px;color:#0f172a;font-family:Menlo,Consolas,monospace;">
                  ${escapeHtml(code)}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:24px;font-size:13px;line-height:20px;color:#64748b;">
                Ce code expire dans ${expiresInMinutes} minutes. Si vous n'êtes pas à l'origine de cette connexion, ignorez cet email et envisagez de changer votre mot de passe.
              </td>
            </tr>
            <tr>
              <td style="border-top:1px solid #e2e8f0;padding-top:16px;font-size:12px;color:#94a3b8;">
                Veridian — ${new Date().getFullYear()}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `Code de connexion Veridian

Une nouvelle connexion à votre compte Veridian a été demandée.
Utilisez le code ci-dessous pour confirmer qu'il s'agit bien de vous.

Code : ${code}

Ce code expire dans ${expiresInMinutes} minutes. Si vous n'êtes pas à l'origine
de cette connexion, ignorez cet email.`;

  return { subject, html, text };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
