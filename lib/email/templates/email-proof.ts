// Template HTML inline pour l'email "Confirmez votre adresse".

export type EmailProofTemplateVars = {
  confirmUrl: string;
  expiresInHours: number;
};

export function renderEmailProofEmail({ confirmUrl, expiresInHours }: EmailProofTemplateVars): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Confirmez votre adresse pour ouvrir vos outils Veridian';

  const html = `<!DOCTYPE html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;">
      <tr><td style="padding:24px 24px 8px;font-size:20px;font-weight:600;">Veridian</td></tr>
      <tr><td style="padding:8px 24px;font-size:14px;line-height:22px;color:#475569;">
        Pour ouvrir vos outils depuis votre espace Veridian, confirmez que cette adresse est bien la vôtre.
        Vous resterez connecté à votre espace pendant la confirmation.
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <a href="${confirmUrl}" style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Confirmer mon adresse</a>
      </td></tr>
      <tr><td style="padding:8px 24px 24px;font-size:12px;line-height:18px;color:#64748b;">
        Ce lien est valable ${expiresInHours} heures. Si vous n'avez pas créé de compte Veridian, ignorez ce message : rien ne sera ouvert sans cette confirmation.
      </td></tr>
    </table>
  </body>
</html>`;

  const text = `Pour ouvrir vos outils depuis votre espace Veridian, confirmez que cette adresse est bien la vôtre :

${confirmUrl}

Ce lien est valable ${expiresInHours} heures. Si vous n'avez pas créé de compte Veridian, ignorez ce message : rien ne sera ouvert sans cette confirmation.`;

  return { subject, html, text };
}
