import { expect, it } from 'vitest';

import { nomDEcriture } from '@/lib/mcp/programme';
import { CANDIDATS, connecteur, CONNECTEURS, connecteursOuverts, outilRelu, saitEcrire } from '@/lib/connecteurs/registre';

it('CONNECTEURS : HTTPS, une clé à soi, jamais le nom d\'une de nos apps ni un service d\'argent', () => {
  expect(CONNECTEURS.every((c) => c.mcpUrl.startsWith('https://') && /^[a-z]{3,20}$/.test(c.cle))).toBe(true);
  expect(CONNECTEURS.map((c) => c.cle), 'seulement ceux dont on a vu l\'écran').toEqual(['notion', 'linear', 'webflow', 'sentry']);
  expect(new Set(CONNECTEURS.map((c) => c.cle)).size).toBe(CONNECTEURS.length);
  expect(CONNECTEURS.filter((c) => ['hub', 'notifuse', 'prospection', 'analytics', 'twenty', 'crm', 'academy', 'cms', 'stripe', 'paypal'].includes(c.cle))).toEqual([]);
});
it('connecteur : une clé connue, rien d\'autre', () => expect([connecteur('notion')?.nom, connecteur('autre'), connecteur(undefined), connecteur(['notion'])]).toEqual(['Notion', null, null, null]));
it('connecteursOuverts : fermé par défaut, « 1 » ouvre à tous, « @id » à cette personne seulement (27/11)', () => {
  expect([{}, { CONNECTEURS_OUVERTS: '0' }, { CONNECTEURS_OUVERTS: 'true' }, { CONNECTEURS_OUVERTS: '1' }].map((e) => connecteursOuverts('h1', e as never))).toEqual([false, false, false, true]);
  const robert = { CONNECTEURS_OUVERTS: '@h1, @h2' } as never;
  expect([connecteursOuverts('h1', robert), connecteursOuverts('h2', robert), connecteursOuverts('h3', robert), connecteursOuverts(null, robert), connecteursOuverts(undefined, robert)]).toEqual([true, true, false, false, false]);
  expect(connecteursOuverts('h1', { CONNECTEURS_OUVERTS: 'h1' } as never), 'sans @ : rien').toBe(false);
});
it('CANDIDATS (VER-114) : jamais servis, disjoints du registre, HTTPS, PKCE de rigueur, jamais un service d\'argent', () => {
  expect(CANDIDATS.length).toBe(15);
  expect(CANDIDATS.every((c) => c.mcpUrl.startsWith('https://') && c.oauth.emetteur.startsWith('https://') && (Boolean(c.oauth.enregistrement) || Boolean(c.preinscrit)) && /^[a-z]{3,20}$/.test(c.cle))).toBe(true);
  expect(CANDIDATS.filter((c) => connecteur(c.cle) !== null || CONNECTEURS.some((x) => x.cle === c.cle)).map((c) => c.cle), 'un candidat n\'est pas servi').toEqual([]);
  expect(CANDIDATS.filter((c) => ['stripe', 'paypal', 'canva'].includes(c.cle))).toEqual([]);
  expect(CANDIDATS.every((c) => Object.keys(c.outils).length === 0)).toBe(true);
});
it('hôtes figés : chacun s\'autorise chez lui, sur l\'hôte de son serveur MCP', () => {
  for (const c of CONNECTEURS) {
    const h = new URL(c.mcpUrl).host;
    expect([c.oauth, /^[a-z0-9.-]+$/.test(h)]).toEqual([{ emetteur: `https://${h}`, autorisation: h, jeton: h, enregistrement: h, revocation: h }, true]);
  }
});
it('outils : empreinte entière, et jamais un nom d\'écriture classé en lecture', () => {
  for (const c of CONNECTEURS) for (const [n, o] of Object.entries(c.outils)) {
    expect([/^[0-9a-f]{64}$/.test(o.empreinte), /^[A-Za-z0-9_-]{1,64}$/.test(n), o.acces === 'lecture' && nomDEcriture(n)], `${c.cle}.${n}`).toEqual([true, true, false]);
  }
});
it('outilRelu, saitEcrire', () => {
  const c = { ...CONNECTEURS[0], outils: { a: { acces: 'ecriture' as const, empreinte: 'x' } } };
  expect([outilRelu(c, 'a')?.acces, outilRelu(c, 'b'), outilRelu(c, 'constructor'), outilRelu(c, '__proto__'), saitEcrire(c), saitEcrire(CONNECTEURS[0])]).toEqual(['ecriture', null, null, null, true, false]);
});
it('Google (27/11) : client préinscrit au coffre, jamais une portée restreinte, jeton de renouvellement demandé', () => {
  const g = CANDIDATS.filter((c) => c.preinscrit);
  expect(g.map((c) => c.cle)).toEqual(['gdrive', 'gagenda']);
  const restreintes = /gmail\.(readonly|modify|compose|metadata)|mail\.google\.com|auth\/drive(\.readonly)?$/;
  expect(g.filter((c) => restreintes.test(c.portee ?? ''))).toEqual([]);
  expect(g.every((c) => c.depart?.access_type === 'offline' && c.preinscrit?.id === 'INTEG_GOOGLE_CLIENT_ID' && c.oauth.enregistrement === '')).toBe(true);
});
