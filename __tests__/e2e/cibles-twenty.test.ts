import { describe, expect, it } from 'vitest';

import { twentyPar } from '@/e2e/systeme-sso/lib/cibles';

// 09/11 : la batterie prod testait le CRM staging (défaut en dur), l'arrivée Twenty échouait à tort.
describe('cible Twenty de la batterie', () => {
  it('un Hub de prod vise le CRM de prod, pas le staging', () => {
    expect(twentyPar('https://app.veridian.site')).toBe('https://crm.app.veridian.site');
  });
  it('un Hub de staging vise le CRM de staging', () => {
    expect(twentyPar('https://hub.staging.veridian.site')).toBe('https://crm.staging.veridian.site');
  });
});
