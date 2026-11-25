import { expect, it } from 'vitest';

import { renderAdresseAnnuleeEmail, renderAdresseChangeeEmail } from '@/lib/email/templates/adresse-changee';

it('renderAdresseChangeeEmail : le délai, le lien, et rien à faire si c\'est vous ; aucune adresse dite', () => {
  const m = renderAdresseChangeeEmail({ lien: 'https://app.veridian.site/auth/adresse?token=t', heures: 72 });
  for (const t of [m.text, m.html]) {
    expect(t).toContain('https://app.veridian.site/auth/adresse?token=t');
    expect(t).toContain('72 heures');
    expect(t).toContain('rien à faire');
    expect(t).not.toMatch(/\w@\w/);
    expect(t).not.toContain(' — ');
  }
});
it('renderAdresseAnnuleeEmail : aucun lien', () => {
  const m = renderAdresseAnnuleeEmail();
  expect(m.text + m.html).not.toMatch(/href=|https?:/);
});
