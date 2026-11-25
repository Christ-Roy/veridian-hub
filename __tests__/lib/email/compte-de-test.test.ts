import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { COMPTE_DE_TEST, estCompteDeTest } from '@/lib/email/compte-de-test';

it('ancré des deux côtés, notre domaine seul', () => {
  expect([COMPTE_DE_TEST.source.startsWith('^'), COMPTE_DE_TEST.source.endsWith('$'), COMPTE_DE_TEST.flags]).toEqual([true, true, '']);
  expect(['e2e-sso-a1-b@veridian.site', 'E2E-SSO-A@VERIDIAN.SITE '].map(estCompteDeTest)).toEqual([true, true]);
  expect(['e2e-sso-a@veridianXsite', 'e2e-sso-a@sous.veridian.site', 'e2e-a@veridian.site', '', 'e2e-sso-a@veridian.site\nx@y.fr'].map(estCompteDeTest)).toEqual([false, false, false, false, false]);
});

it('la batterie crée ses comptes sous ce motif : sinon ses mails partiraient pour de vrai', () => {
  const cibles = readFileSync('e2e/systeme-sso/lib/cibles.ts', 'utf8');
  const un = (n: string) => new RegExp(`${n} = '([^']+)'`).exec(cibles)![1];
  expect(estCompteDeTest(`${un('PREFIXE_COMPTE')}mwv1abc-etiquette@${un('DOMAINE_COMPTE')}`)).toBe(true);
});
