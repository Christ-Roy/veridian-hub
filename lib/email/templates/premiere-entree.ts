// Code envoyé à une adresse que l'organisation attend, à sa première entrée par le compte de l'organisation (VER-261).
export function renderPremiereEntreeEmail({ code, minutes }: { code: string; minutes: number }): { subject: string; html: string; text: string } {
  const subject = 'Votre code pour entrer dans Veridian';
  const corps = 'Quelqu\'un vient de se connecter à Veridian avec le compte de votre organisation et dit être vous. Si c\'est vous, saisissez ce code :';
  const fin = `Ce code est valable ${minutes} minutes. Si ce n'est pas vous, ignorez ce message : sans ce code, rien n'est relié.`;
  return {
    subject,
    text: `${corps}\n\n${code}\n\n${fin}\n`,
    html: `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8" /><title>${subject}</title></head><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;"><tr><td style="padding:24px 24px 8px;font-size:20px;font-weight:600;">Veridian</td></tr><tr><td style="padding:8px 24px;font-size:14px;line-height:22px;color:#475569;">${corps}</td></tr><tr><td style="padding:16px 24px;font-size:28px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;">${code}</td></tr><tr><td style="padding:8px 24px 24px;font-size:12px;line-height:18px;color:#64748b;">${fin}</td></tr></table></body></html>`,
  };
}
