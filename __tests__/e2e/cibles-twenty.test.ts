import { describe, expect, it } from 'vitest';

import { masquer, twentyPar } from '@/e2e/systeme-sso/lib/cibles';

// 09/11 : la batterie prod testait le CRM staging (défaut en dur), l'arrivée Twenty échouait à tort.
describe('cible Twenty de la batterie', () => {
  it('un Hub de prod vise le CRM de prod, pas le staging', () => {
    expect(twentyPar('https://app.veridian.site')).toBe('https://crm.app.veridian.site');
  });
  it('un Hub de staging vise le CRM de staging', () => {
    expect(twentyPar('https://hub.staging.veridian.site')).toBe('https://crm.staging.veridian.site');
  });
});

// 25/11 : un loginToken du CRM (compte d'épreuve) est passé dans un message d'échec. La règle ne nommait que token, t et code.
describe('masquage des jetons dans les journaux de la batterie', () => {
  const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4IiwidHlwZSI6IkxPR0lOIn0.c2lnbmF0dXJl';
  it.each([`https://x.test/verify?loginToken=${jwt}`, `Bearer ${jwt}`, `tronqué ${jwt.slice(0, 40)}`, `https://x.test/a?token=abcdef123456`, `https://x.test/#refresh_token=abcdef123456`])('%#', (s) => {
    expect(masquer(s)).not.toMatch(/eyJhbGci|abcdef123456/);
  });
  it('laisse le reste lisible', () => {
    expect(masquer('entrées https://crm.test/objects/companies, statut 423')).toBe('entrées https://crm.test/objects/companies, statut 423');
  });
});
