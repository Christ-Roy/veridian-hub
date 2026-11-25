import { expect, it } from 'vitest';

import { connecteur, CONNECTEURS, connecteursOuverts } from '@/lib/connecteurs/registre';

it('CONNECTEURS : HTTPS, une clé à soi, jamais le nom d\'une de nos apps ni un service d\'argent', () => {
  expect(CONNECTEURS.every((c) => c.mcpUrl.startsWith('https://') && /^[a-z]{3,20}$/.test(c.cle))).toBe(true);
  expect(CONNECTEURS.map((c) => c.cle), 'seulement ceux dont on a vu l\'écran').toEqual(['notion', 'linear', 'webflow', 'sentry']);
  expect(new Set(CONNECTEURS.map((c) => c.cle)).size).toBe(CONNECTEURS.length);
  expect(CONNECTEURS.filter((c) => ['hub', 'notifuse', 'prospection', 'analytics', 'twenty', 'crm', 'academy', 'cms', 'stripe', 'paypal'].includes(c.cle))).toEqual([]);
});
it('connecteur : une clé connue, rien d\'autre', () => expect([connecteur('notion')?.nom, connecteur('autre'), connecteur(undefined), connecteur(['notion'])]).toEqual(['Notion', null, null, null]));
it('connecteursOuverts : fermé par défaut, seul « 1 » ouvre', () => expect([{}, { CONNECTEURS_OUVERTS: '0' }, { CONNECTEURS_OUVERTS: 'true' }, { CONNECTEURS_OUVERTS: '1' }].map((e) => connecteursOuverts(e as never))).toEqual([false, false, false, true]));
