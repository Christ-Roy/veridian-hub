// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ renouveler: vi.fn(), revoquer: vi.fn(), audits: [] as any[], oublier: vi.fn(), essai: null as any }));
vi.mock('@/lib/connecteurs/oauth', () => ({ renouveler: (...a: unknown[]) => m.renouveler(...a), revoquer: (...a: unknown[]) => m.revoquer(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: async (_d: unknown, l: unknown) => { m.audits.push(l); } }));
vi.mock('@/lib/mcp/cache', () => ({ oublierUtilisateur: (...a: unknown[]) => m.oublier(...a) }));

import { connexionsDe, couper, couperToutes, garder, jetonDe, reglerEcriture, trancher } from '@/lib/connecteurs/coffre';
import { connecteur } from '@/lib/connecteurs/registre';

import { fausseBaseConnexions } from './fausse-base';

const N = connecteur('notion')!;
const NOW = Date.parse('2026-11-25T10:00:00Z');
const R = 'https://hub.test/r';
const J = (o: object = {}) => ({ acces: 'acces-1', refresh: 'refresh-1', expireLe: new Date(NOW + 3_600_000), compte: null, ...o });
const base = fausseBaseConnexions();
const db = base as never;
const l = () => base.connexionExterne.lignes;
const poser = (j: object = {}, u = 'h', cle = 'notion') => garder(db, u, cle, J(j), R, { now: NOW });
const jeton = (o: object = {}, u = 'h') => jetonDe(db, u, N, R, { now: NOW, ...o });
const revoques = () => m.revoquer.mock.calls.flatMap((c) => c[2] as string[]);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VAULT_ENC_KEY', 'k'.repeat(40));
  vi.spyOn(console, 'error').mockReturnValue();
  m.audits.length = 0;
  base.connexionExterne.vider();
  base.user.vider();
  m.revoquer.mockResolvedValue(true);
});

it('garder : chiffré, jamais au journal, lecture seule ; les outils de la personne se relisent', async () => {
  expect(await poser()).toBe('branchee');
  expect([l().length, l()[0].ecriture, /acces-|refresh-/.test(JSON.stringify(l())), /acces-|refresh-/.test(JSON.stringify(m.audits)), m.oublier.mock.calls[0]]).toEqual([1, false, false, false, ['h', 'notion']]);
});
it('garder : rien n\'a pu être gardé, le jeton neuf ne reste pas chez le service', async () => {
  vi.spyOn(base.connexionExterne, 'create').mockRejectedValueOnce(new Error('base'));
  await expect(poser()).rejects.toThrow('base');
  expect(revoques()).toEqual(['refresh-1', 'acces-1']);
});
it('garder : compte supprimé pendant l\'échange, la connexion ne lui survit pas, le jeton non plus', async () => {
  base.user.absents.add('h');
  await expect(poser()).rejects.toThrow('compte_absent');
  expect([l().length, revoques()]).toEqual([0, ['refresh-1', 'acces-1']]);
});
it('connexionsDe : tout le registre, son état à elle, sans jeton', async () => {
  await poser({ compte: 'ACME' });
  const x = await connexionsDe(db, 'h');
  expect(x.find((y) => y.cle === 'notion')).toMatchObject({ etat: 'active', compte: 'ACME', ecriture: false, saitEcrire: false, relu: false, attente: null });
  expect([x.find((y) => y.cle === 'linear')?.etat, JSON.stringify(x).includes('v1.')]).toEqual(['absente', false]);
  expect((await connexionsDe(db, 'autre')).every((y) => y.etat === 'absente'), 'jamais celles d\'une autre personne').toBe(true);
});

describe('rebranchement', () => {
  beforeEach(async () => { await poser({ compte: 'ACME' }); });
  const neuf = () => poser({ acces: 'acces-2', refresh: 'refresh-2', compte: 'AUTRE' });
  it('rien n\'est remplacé en silence : l\'ancien sert toujours, le neuf attend, les deux comptes sont montrés', async () => {
    expect([await neuf(), await jeton(), revoques()]).toEqual(['a_confirmer', 'acces-1', []]);
    expect((await connexionsDe(db, 'h')).find((y) => y.cle === 'notion')).toMatchObject({ compte: 'ACME', attente: { compte: 'AUTRE' } });
    expect(/acces-2|refresh-2/.test(JSON.stringify(l()))).toBe(false);
  });
  it('même pour une connexion à rebrancher : on ne sait pas que c\'est le même compte', async () => {
    l()[0].etat = 'a_rebrancher';
    expect([await neuf(), await jeton()]).toEqual(['a_confirmer', null]);
  });
  it('remplacer : le neuf sert, l\'ancien est révoqué en entier, l\'écriture ne s\'hérite pas', async () => {
    l()[0].ecriture = true;
    await neuf();
    expect(await trancher(db, 'h', 'notion', 'remplacer', R)).toEqual({ fait: true, revoquee: true });
    expect([await jeton(), revoques(), l()[0].ecriture, l()[0].compte, l()[0].attenteChiffre]).toEqual(['acces-2', ['refresh-1', 'acces-1'], false, 'AUTRE', null]);
    expect(await trancher(db, 'h', 'notion', 'remplacer', R), 'deux fois').toEqual({ fait: false, revoquee: false });
  });
  it('garder l\'actuel : le neuf est révoqué, rien d\'autre ne bouge', async () => {
    l()[0].ecriture = true;
    await neuf();
    m.revoquer.mockResolvedValue(false);
    expect(await trancher(db, 'h', 'notion', 'garder', R)).toEqual({ fait: true, revoquee: false });
    expect([await jeton(), revoques(), l()[0].ecriture, l()[0].attenteChiffre]).toEqual(['acces-1', ['refresh-2', 'acces-2'], true, null]);
  });
  it('un second rebranchement : l\'attente d\'avant est révoquée, jamais oubliée vivante', async () => {
    await neuf();
    await poser({ acces: 'acces-3', refresh: 'refresh-3' });
    expect(revoques()).toEqual(['refresh-2', 'acces-2']);
  });
  it('service qui rend le MÊME jeton : il n\'est pas révoqué sous celui qu\'on garde', async () => {
    await poser({ acces: 'acces-2' });
    await trancher(db, 'h', 'notion', 'garder', R);
    expect(revoques()).toEqual(['acces-2']);
  });
  it('à une autre personne, ou sans attente : rien', async () => {
    await neuf();
    expect(await trancher(db, 'v', 'notion', 'remplacer', R)).toEqual({ fait: false, revoquee: false });
    expect(await trancher(db, 'h', 'linear', 'garder', R)).toEqual({ fait: false, revoquee: false });
  });
  it('couper pendant l\'attente : les deux jeux partent', async () => {
    await neuf();
    await couper(db, 'h', 'notion', R);
    expect([revoques(), l().length]).toEqual([['refresh-1', 'acces-1', 'refresh-2', 'acces-2'], 0]);
  });
  it('un renouvellement entre la lecture et le choix : relu, c\'est le jeton du moment qui est révoqué', async () => {
    await neuf();
    const vraie = base.connexionExterne.updateMany;
    vi.spyOn(base.connexionExterne, 'updateMany').mockImplementationOnce(async (a: any) => {
      m.renouveler.mockResolvedValue(J({ acces: 'acces-9', refresh: 'refresh-9' }));
      await jeton({ force: true });
      return vraie(a);
    });
    await trancher(db, 'h', 'notion', 'remplacer', R);
    expect([await jeton(), revoques()]).toEqual(['acces-2', ['refresh-9', 'acces-9']]);
  });
});

describe('reglerEcriture', () => {
  it('éteindre vaut tout de suite ; allumer un service qui n\'a aucun outil d\'écriture relu : refusé', async () => {
    await poser();
    expect([await reglerEcriture(db, 'h', N, true), l()[0].ecriture]).toEqual([false, false]);
    const avec = { ...N, outils: { e: { acces: 'ecriture' as const, empreinte: 'x' } } };
    expect([await reglerEcriture(db, 'h', avec, true), l()[0].ecriture]).toEqual([true, true]);
    m.oublier.mockClear();
    expect([await reglerEcriture(db, 'h', N, false), l()[0].ecriture, m.oublier.mock.calls]).toEqual([true, false, [['h', 'notion']]]);
  });
  it('service par service, personne par personne ; à rebrancher : ne s\'allume pas', async () => {
    const avec = { ...N, outils: { e: { acces: 'ecriture' as const, empreinte: 'x' } } };
    await poser();
    await poser({}, 'v');
    await poser({}, 'h', 'linear');
    await reglerEcriture(db, 'h', avec, true);
    expect(l().map((x) => [x.hubUserId, x.connecteur, x.ecriture])).toEqual([['h', 'notion', true], ['v', 'notion', false], ['h', 'linear', false]]);
    l()[1].etat = 'a_rebrancher';
    expect(await reglerEcriture(db, 'v', avec, true)).toBe(false);
  });
});

describe('jetonDe', () => {
  beforeEach(async () => { await poser(); });
  it('valable : rendu tel quel ; absente, ou à une autre personne : null', async () => {
    expect([await jeton(), await jeton({}, 'autre'), m.renouveler.mock.calls.length]).toEqual(['acces-1', null, 0]);
  });
  it('fini dans la minute, ou refusé par le service : renouvelé UNE fois, même demandé dix fois à la fois', async () => {
    m.renouveler.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); return J({ acces: 'acces-2', refresh: 'refresh-2' }); });
    expect(await Promise.all(Array.from({ length: 10 }, () => jeton({ now: NOW + 3_590_000 })))).toEqual(Array(10).fill('acces-2'));
    expect([m.renouveler.mock.calls.length, m.renouveler.mock.calls[0][2]]).toEqual([1, 'refresh-1']);
    await jeton({ force: true });
    expect([m.renouveler.mock.calls[1][2], revoques()], 'avec le jeton tourné').toEqual(['refresh-2', []]);
  });
  it('le service refuse le renouvellement : à rebrancher, et plus rien ne part', async () => {
    m.renouveler.mockRejectedValue(Object.assign(new Error('x'), { error: 'invalid_grant' }));
    expect([await jeton({ force: true }), l()[0].etat, await jeton()]).toEqual([null, 'a_rebrancher', null]);
  });
  it('service en panne : on ne conclut rien', async () => {
    m.renouveler.mockRejectedValue(new Error('ECONNRESET'));
    await expect(jeton({ force: true })).rejects.toThrow('service_injoignable');
    expect([l()[0].etat, await jeton()]).toEqual(['active', 'acces-1']);
  });
  it('une autre version renouvelle : on attend son jeton, le même renouvellement n\'est jamais présenté deux fois', async () => {
    const { chiffrer } = await import('@/lib/ia/coffre');
    l()[0].renouvellementLe = new Date(NOW - 1_000);
    setTimeout(() => { Object.assign(l()[0], { accesChiffre: chiffrer('acces-9') }); }, 20);
    expect([await jeton({ force: true, attenteMs: 5 }), m.renouveler.mock.calls.length]).toEqual(['acces-9', 0]);
    l()[0].renouvellementLe = new Date(NOW - 1_000);
    await expect(jeton({ force: true, attenteMs: 1 }), 'elle n\'aboutit pas').rejects.toThrow('service_injoignable');
    setTimeout(() => void couper(db, 'h', 'notion', R), 10);
    expect([await jeton({ force: true, attenteMs: 5 }), m.renouveler.mock.calls.length], 'coupée pendant l\'attente').toEqual([null, 0]);
  });
  it('celle qui renouvelait est morte, ou le service était en panne : le bail ne bloque pas', async () => {
    l()[0].renouvellementLe = new Date(NOW - 60_000);
    m.renouveler.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(J({ acces: 'acces-2', refresh: 'refresh-2' }));
    await expect(jeton({ force: true })).rejects.toThrow('service_injoignable');
    expect([await jeton({ force: true }), await jeton({ force: true }), l()[0].renouvellementLe]).toEqual(['acces-2', 'acces-2', null]);
  });
  it('sans jeton de renouvellement : à rebrancher', async () => {
    l()[0].refreshChiffre = null;
    expect([await jeton({ now: NOW + 9_000_000 }), l()[0].etat]).toEqual([null, 'a_rebrancher']);
  });

  describe('croisé avec un renouvellement en cours', () => {
    const pendant = (f: () => Promise<unknown>, j: object = {}) => m.renouveler.mockImplementation(async () => { await f(); return J({ acces: 'neuf-a', refresh: 'neuf-r', ...j }); });
    it('coupée : le jeton neuf est révoqué, jamais rendu, jamais gardé', async () => {
      pendant(() => couper(db, 'h', 'notion', R));
      expect([await jeton({ force: true }), l().length, revoques()]).toEqual([null, 0, ['refresh-1', 'acces-1', 'neuf-r', 'neuf-a']]);
      expect(m.audits.some((a) => a.action === 'connecteur.jeton_orphelin')).toBe(true);
    });
    it('coupée, puis rebranchée : le neuf orphelin est révoqué, celui de la connexion neuve reste', async () => {
      pendant(async () => { await couper(db, 'h', 'notion', R); await poser({ acces: 'acces-5', refresh: 'refresh-5' }); });
      await jeton({ force: true });
      expect([revoques().includes('acces-5'), revoques().includes('neuf-a'), await jeton()]).toEqual([false, true, 'acces-5']);
    });
    it('l\'autre version l\'a renouvelée entre-temps : son jeton à elle, le nôtre révoqué', async () => {
      const { chiffrer } = await import('@/lib/ia/coffre');
      pendant(async () => { Object.assign(l()[0], { accesChiffre: chiffrer('acces-9'), refreshChiffre: chiffrer('refresh-9') }); });
      expect([await jeton({ force: true }), revoques()]).toEqual(['acces-9', ['neuf-r', 'neuf-a']]);
    });
    it('un service qui ne tourne pas ses jetons : le renouvellement commun n\'est pas révoqué sous l\'autre', async () => {
      const { chiffrer } = await import('@/lib/ia/coffre');
      pendant(async () => { Object.assign(l()[0], { accesChiffre: chiffrer('acces-9') }); }, { refresh: 'refresh-1' });
      expect([await jeton({ force: true }), revoques()]).toEqual(['acces-9', ['neuf-a']]);
    });
    it('l\'autre version l\'a renouvelée, la nôtre est refusée : pas un débranchement', async () => {
      const { chiffrer } = await import('@/lib/ia/coffre');
      m.renouveler.mockImplementation(async () => { l()[0].accesChiffre = chiffrer('acces-9'); throw Object.assign(new Error('x'), { error: 'invalid_grant' }); });
      expect([await jeton({ force: true }), l()[0].etat]).toEqual(['acces-9', 'active']);
    });
  });
});

describe('couper', () => {
  it('effacée même si le service ne répond pas, tous ses jetons, et seulement la sienne ; la révocation ratée se dit', async () => {
    await poser();
    await poser({}, 'v');
    m.revoquer.mockResolvedValue(false);
    expect(await couper(db, 'h', 'notion', R)).toEqual({ coupee: true, revoquee: false });
    expect([l().map((x) => x.hubUserId), revoques()]).toEqual([['v'], ['refresh-1', 'acces-1']]);
    expect(await couper(db, 'h', 'notion', R)).toEqual({ coupee: false, revoquee: false });
  });
  it('coffre illisible : effacée, et jamais dite révoquée', async () => {
    await poser();
    vi.stubEnv('VAULT_ENC_KEY', 'autre'.repeat(10));
    expect([await couper(db, 'h', 'notion', R), l().length, m.revoquer.mock.calls.length]).toEqual([{ coupee: true, revoquee: false }, 0, 0]);
  });
  it('un renouvellement glissé entre la lecture et l\'effacement : ce sont ses jetons qui sont révoqués', async () => {
    await poser();
    const vraie = base.connexionExterne.deleteMany;
    vi.spyOn(base.connexionExterne, 'deleteMany').mockImplementationOnce(async (a: any) => {
      m.renouveler.mockResolvedValue(J({ acces: 'acces-9', refresh: 'refresh-9' }));
      await jeton({ force: true });
      return vraie(a);
    });
    expect([await couper(db, 'h', 'notion', R), revoques(), l().length]).toEqual([{ coupee: true, revoquee: true }, ['refresh-9', 'acces-9'], 0]);
  });
});
it('couperToutes : un compte supprimé n\'en laisse aucune ; une qui échoue n\'arrête pas les autres et se compte', async () => {
  await poser();
  await poser({}, 'h', 'linear');
  await poser({}, 'v', 'linear');
  m.revoquer.mockResolvedValueOnce(false);
  expect([await couperToutes(db, 'h', R), l().map((x) => x.hubUserId)]).toEqual([{ coupees: 2, nonConfirmees: 1, echecs: 0 }, ['v']]);
  await poser();
  await poser({}, 'h', 'linear');
  vi.spyOn(base.connexionExterne, 'deleteMany').mockRejectedValueOnce(new Error('base'));
  expect(await couperToutes(db, 'h', R)).toEqual({ coupees: 1, nonConfirmees: 0, echecs: 1 });
});
