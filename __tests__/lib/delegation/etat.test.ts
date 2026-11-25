// @vitest-environment node
/** Par défaut (25/11) : un geste est actif où les deux apps sont ouvertes ; un événement, chez les organisations neuves ; une coupure tient ; rien n'est dit consenti. */
import { describe, expect, it } from 'vitest';

import { contexteDe, etatDe, liaisonActive, NEUVE_DEPUIS, noterPassage } from '@/lib/delegation/etat';
import { empreintePortees, paire, PAIRES, type AppPaire } from '@/lib/delegation/paires';

import { base } from './fausse';

const GESTE = paire('prospection>crm')!;
const EVT = paire('notifuse>crm')!;
const c = (apps: AppPaire[], neuve = false) => ({ ouvertes: new Set(apps), neuve });
const TOUT = c(['prospection', 'crm', 'notifuse']);
const ligne = (o: object = {}) => ({ etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(GESTE), ...o });

describe('etatDe', () => {
  it('un geste : actif par défaut où les deux apps sont ouvertes, jamais dit consenti ; sinon éteint', () => {
    expect(etatDe(GESTE, null, TOUT, true)).toEqual({ etat: 'allumee', consentie: false, parDefaut: true });
    for (const apps of [['prospection'], ['crm'], []] as AppPaire[][]) expect(etatDe(GESTE, null, c(apps), true).etat, apps.join()).toBe('eteinte');
  });
  it('un événement : neuve seulement ; existante, proposée et éteinte', () => {
    expect([etatDe(EVT, null, TOUT, true).etat, etatDe(EVT, null, { ...TOUT, neuve: true }, true).etat]).toEqual(['eteinte', 'allumee']);
  });
  it('une coupure posée n\'est jamais rallumée, quelle que soit sa cause', () => {
    for (const l of [ligne({ etat: 'eteinte' }), ligne({ etat: 'eteinte', consentiLe: null }), ligne({ consentiLe: null }), ligne({ portees: 'ancienne' })]) expect(etatDe(GESTE, l, { ...TOUT, neuve: true }, true)).toMatchObject({ etat: 'eteinte', parDefaut: false });
  });
  it('consentie : allumée, et dite réglée, même une app fermée', () => expect(etatDe(GESTE, ligne(), c([]), true)).toEqual({ etat: 'allumee', consentie: true, parDefaut: false }));
  it('pas servie : indisponible', () => expect(etatDe(GESTE, null, TOUT, false).etat).toBe('indisponible'));
  it('une ligne qui ne garde que le passage ne règle rien', () => expect(etatDe(GESTE, { etat: 'defaut', consentiLe: null, portees: null }, TOUT, true).parDefaut).toBe(true));
  it('une portée élargie, celle qui fait partir du courrier, Academy : jamais par défaut', () => {
    expect(etatDe({ ...GESTE, portees: [...GESTE.portees, 'crm:tout.lire'] }, null, TOUT, true).etat).toBe('eteinte');
    expect(PAIRES.filter((p) => etatDe(p, null, { ...TOUT, neuve: true }, true).parDefaut).map((p) => p.cle)).toEqual(['prospection>crm', 'prospection>notifuse', 'notifuse>crm', 'crm>notifuse', 'crm>prospection']);
  });
});

describe('contexteDe', () => {
  const db = (t: object | null, modules?: string[]) => ({ tenant: { findFirst: async () => t }, organisation: { findUnique: async () => (modules ? { modules } : null) } }) as never;
  const T = { prospectionProvisionedAt: null, notifuseWorkspaceSlug: null, metadata: {}, createdAt: new Date('2026-06-01') };
  it('Academy : son espace existe', async () => expect((await contexteDe(db({ ...T, metadata: { academy: { workspace_id: 'a' } } }), 'T')).ouvertes.has('academy')).toBe(true));
  it('un espace qui existe, ou une app cochée', async () => {
    expect(Array.from((await contexteDe(db({ ...T, prospectionProvisionedAt: new Date(), metadata: { crm: { workspace_id: 'w' } } }, ['notifuse']), 'T')).ouvertes).sort()).toEqual(['crm', 'notifuse', 'prospection']);
    expect((await contexteDe(db(T), 'T')).ouvertes.size).toBe(0);
  });
  it('neuve : née le jour de la règle ou après', async () => {
    expect([(await contexteDe(db(T), 'T')).neuve, (await contexteDe(db({ ...T, createdAt: NEUVE_DEPUIS }), 'T')).neuve]).toEqual([false, true]);
  });
  it('organisation inconnue ou supprimée : rien d\'ouvert', async () => expect(await contexteDe(db(null, ['crm']), 'T')).toEqual({ ouvertes: new Set(), neuve: false }));
});

it('liaisonActive et noterPassage : le passage se garde sans rien régler, la coupure l\'emporte ensuite', async () => {
  const db = base();
  db.tenant.lignes.push({ id: 'T', userId: 'u', status: 'active', deletedAt: null, prospectionProvisionedAt: new Date(), metadata: { crm: { workspace_id: 'w' } }, createdAt: new Date('2026-01-01') });
  expect(await liaisonActive(db as never, GESTE, 'T')).toBe(true);
  await noterPassage(db as never, GESTE, 'T');
  expect([db.integrationPaire.lignes[0].etat, await liaisonActive(db as never, GESTE, 'T')]).toEqual(['defaut', true]);
  db.integrationPaire.lignes[0].etat = 'eteinte';
  await noterPassage(db as never, GESTE, 'T');
  expect([db.integrationPaire.lignes[0].etat, await liaisonActive(db as never, GESTE, 'T')]).toEqual(['eteinte', false]);
});
