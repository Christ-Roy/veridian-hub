import { expect, it } from 'vitest';

import { lienApp } from '@/lib/apps/lien-app';

const env = { CRM_API_URL: 'https://crm.test/', NOTIFUSE_API_URL: 'https://mail.test', NEXT_PUBLIC_PROSPECTION_URL: 'https://atlas.test' } as never;
it.each([
  ['crm', 'https://crm.test/'],
  ['notifuse', 'https://mail.test/console/'],
  ['prospection', 'https://atlas.test/'],
])('%s passe par le rebond, sans jeton', (cle, cible) => expect(lienApp(cle, env)).toBe(`/login?next=${encodeURIComponent(cible)}`));
it('app non branchée, ou inconnue : aucun lien', () => expect([lienApp('academy', env), lienApp('x', env)]).toEqual([null, null]));
