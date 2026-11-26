/**
 * Les essais tenus des heures (48, 49) et la recette de A à Z (50) ne tournent que nommés : la batterie complète en prod ne les embarque jamais
 * (26/11 : 49 tenait la prod 2 h dans une batterie lancée sans filtre).
 */
import { describe, expect, it } from 'vitest';

import config, { demandeNommee } from '../../e2e/systeme-sso/playwright.config';

const ignores = (argv: string[]) => (demandeNommee(argv) ? [] : (config.testIgnore as RegExp[]));
const ignore = (argv: string[], fichier: string) => ignores(argv).some((re) => re.test(fichier));

describe('batterie : essais et recette seulement nommés', () => {
  it('sans filtre, 48, 49 et 50 sont écartés, les autres cas restent', () => {
    const argv = ['test', '-c', 'playwright.config.ts'];
    expect(demandeNommee(argv)).toBe(false);
    for (const f of ['48-essai-commun-crm.spec.ts', '49-essai-commun-prod.spec.ts', '50-recette-a-z.spec.ts']) expect(ignore(argv, `/x/e2e/systeme-sso/${f}`)).toBe(true);
    for (const f of ['04-rebond.spec.ts', '46-connexion-obligatoire.spec.ts', '99-nettoyage.spec.ts']) expect(ignore(argv, `/x/e2e/systeme-sso/${f}`)).toBe(false);
  });
  it('nommés, ils tournent', () => {
    expect(demandeNommee(['test', '-c', 'playwright.config.ts', '50-'])).toBe(true);
    expect(demandeNommee(['test', '49-essai'])).toBe(true);
    expect(demandeNommee(['test', '08-'])).toBe(false);
  });
});
