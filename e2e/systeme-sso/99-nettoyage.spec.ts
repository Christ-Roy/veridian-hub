/**
 * Nettoyage : uniquement les comptes notés par la batterie (registres de `.run`, préfixe e2e-sso-,
 * domaine veridian.site), app par app (`lib/nettoyage.ts`). Puis la mesure : `hub reconcile` ne doit
 * plus rien citer d'eux, ni au Hub ni dans une app. Le teardown refait ce contrôle après un échec.
 */
import { expect } from '@playwright/test';

import { cas } from './lib/etat';
import { mesurerRestes, nettoyerTout } from './lib/nettoyage';

cas(null, 'les comptes de test sont retirés de chaque app et reconcile n\'en mesure aucun', async () => {
  const { retires, echecs } = await nettoyerTout();
  expect(echecs.join(' ; '), `retraits en échec : ${echecs.join(' ; ')}`).toBe('');
  const restes = await mesurerRestes();
  expect(restes.join(', '), `restes en prod : ${restes.join(', ')}`).toBe('');
  return `${retires} compte(s) retiré(s), 0 reste mesuré`;
}, { timeout: 480_000 });
