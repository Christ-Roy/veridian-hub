import { expect, it } from 'vitest';

import { renderPremiereEntreeEmail } from '@/lib/email/templates/premiere-entree';

it('le code, sa durée, quoi faire sinon ; aucun lien à cliquer', () => {
  const m = renderPremiereEntreeEmail({ code: '012345', minutes: 10 });
  for (const t of [m.text, m.html]) {
    expect(t).toContain('012345');
    expect(t).toContain('10 minutes');
    expect(t).toContain('ignorez ce message');
    expect(t).not.toMatch(/https?:|href=/);
  }
});
