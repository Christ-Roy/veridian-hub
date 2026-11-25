import { expect, it } from 'vitest';

import { montrerInclusAvecSite } from '@/lib/apps/inclus-avec-site';

it('sans site, rien n\'est promis', () => expect(montrerInclusAvecSite({ plan: false, analytics: false, cms: false })).toBe(false));
it('un des deux services servi : l\'autre se propose ; les deux, plus rien', () => {
  expect(montrerInclusAvecSite({ plan: false, analytics: true, cms: false })).toBe(true);
  expect(montrerInclusAvecSite({ plan: false, analytics: false, cms: true })).toBe(true);
  expect(montrerInclusAvecSite({ plan: true, analytics: true, cms: true })).toBe(false);
});
