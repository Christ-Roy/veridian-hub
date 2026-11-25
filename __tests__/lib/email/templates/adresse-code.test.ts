import { expect, it } from 'vitest';

import { renderAdresseCodeEmail } from '@/lib/email/templates/adresse-code';

it('dit le code, sa durée, et quoi faire si on n\'a rien demandé ; aucun lien à cliquer', () => {
  const m = renderAdresseCodeEmail({ code: '012345', minutes: 10 });
  for (const t of [m.text, m.html]) {
    expect(t).toContain('012345');
    expect(t).toContain('10 minutes');
    expect(t).toContain('ignorez ce message');
    expect(t).not.toMatch(/https?:|href=/);
  }
});
