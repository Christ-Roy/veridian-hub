import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { montrerInclusAvecSite } from '@/lib/apps/inclus-avec-site';

it('sans site, rien n\'est promis', () => expect(montrerInclusAvecSite({ plan: false, analytics: false, cms: false })).toBe(false));
// 26/11 : le CMS s'éteint, il ne se propose plus ; seule Analytics se propose, tant qu'elle n'est pas servie.
it('seule Analytics se propose : servie, plus rien ; le CMS ne se propose jamais', () => {
  expect(montrerInclusAvecSite({ plan: false, analytics: true, cms: false })).toBe(false);
  expect(montrerInclusAvecSite({ plan: false, analytics: false, cms: true })).toBe(true);
  expect(montrerInclusAvecSite({ plan: true, analytics: false, cms: false })).toBe(true);
  expect(montrerInclusAvecSite({ plan: true, analytics: true, cms: true })).toBe(false);
});
it('la page ne propose plus le CMS en tuile d\'ombre', () => expect(readFileSync('app/dashboard/page.tsx', 'utf8')).not.toMatch(/ShadowAppCard app=\{APPS\.cms\}/));
it('la page s\'en sert (25/11 : la règle existait, la page ne l\'appelait pas)', () => expect(readFileSync('app/dashboard/page.tsx', 'utf8')).toMatch(/\{montrerInclusAvecSite\(\{ plan: /));
