// Avis à l'ancienne adresse d'un compte, quand sa principale change, et à celle que l'annulation retire (AD-M3).
type Mail = { subject: string; html: string; text: string };

const page = (subject: string, corps: string, fin: string, bouton?: { lien: string; texte: string }): Mail => ({
  subject,
  text: `${corps}\n\n${bouton ? `${bouton.texte} : ${bouton.lien}\n\n` : ''}${fin}\n`,
  html: `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8" /><title>${subject}</title></head><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;"><tr><td style="padding:24px 24px 8px;font-size:20px;font-weight:600;">Veridian</td></tr><tr><td style="padding:8px 24px;font-size:14px;line-height:22px;color:#475569;">${corps}</td></tr>${bouton ? `<tr><td style="padding:16px 24px;"><a href="${bouton.lien}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#0f172a;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${bouton.texte}</a></td></tr>` : ''}<tr><td style="padding:8px 24px 24px;font-size:12px;line-height:18px;color:#64748b;">${fin}</td></tr></table></body></html>`,
});

export const renderAdresseChangeeEmail = (d: { lien: string; heures: number }): Mail =>
  page(
    'Votre adresse de connexion Veridian a changé',
    'L\'adresse principale de votre compte Veridian vient d\'être remplacée par une autre. Si c\'est vous, vous n\'avez rien à faire.',
    `Si ce n'est pas vous, annulez dans les ${d.heures} heures : cette adresse redevient la vôtre, toutes les sessions sont coupées et le mot de passe est retiré.`,
    { lien: d.lien, texte: 'Ce n\'est pas moi, annuler' },
  );

export const renderAdresseAnnuleeEmail = (): Mail =>
  page(
    'Changement d\'adresse annulé sur un compte Veridian',
    'Le changement d\'adresse d\'un compte Veridian vers celle-ci a été annulé par son adresse précédente. Cette adresse n\'est plus liée à ce compte.',
    'Si vous pensez à une erreur, répondez à ce message.',
  );
