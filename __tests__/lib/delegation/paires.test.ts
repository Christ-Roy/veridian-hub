// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { adresseAction, CLE_MCP, cibleServie, empreintePortees, evenementOuvert, paireReglable, paire, pairePour, PAIRES, pairesEntre, paireServie, pairesServies, porteesAccordees, sourceServie } from '@/lib/delegation/paires';

const env = (DELEGATION_CIBLES?: string) => ({ NODE_ENV: 'test', DELEGATION_CIBLES }) as NodeJS.ProcessEnv;

describe('registre des paires', () => {
  it('les paires, une clé chacune, et aucune portée destructive ni complète', () => {
    expect(PAIRES.map((p) => p.cle)).toEqual(['prospection>crm', 'prospection>notifuse', 'notifuse>crm', 'notifuse>crm#activite', 'crm>notifuse', 'crm>notifuse#sequences', 'crm>prospection', 'crm>academy', 'crm>prospection#exclusion', 'analytics>crm#visite']);
    expect(new Set(PAIRES.map((p) => p.cle)).size).toBe(PAIRES.length);
    for (const p of PAIRES) for (const x of p.portees) expect(x).toMatch(new RegExp(`^${p.cible}:[a-z]+\\.(ecrire|lire|inscrire)$`));
  });
  it('paire : par sa clé, sinon rien', () => {
    expect(paire('prospection>crm')?.nature).toBe('action');
    expect(paire('crm>crm')).toBeUndefined();
  });
  it('pairesEntre : seulement ce qui est inscrit, dans ce sens, jamais un événement', () => {
    expect([pairesEntre('crm', 'crm'), pairesEntre('notifuse', 'prospection'), pairesEntre('notifuse', 'crm')]).toEqual([[], [], []]);
    expect(pairesEntre('crm', 'notifuse').map((p) => p.cle)).toEqual(['crm>notifuse', 'crm>notifuse#sequences']);
  });
  it('pairePour : celle qui porte TOUT ce qui est demandé ; deux interrupteurs ne se cumulent pas', () => {
    const q = (s?: string) => pairePour('crm', 'notifuse', s)?.cle;
    expect([q('notifuse:contacts.ecrire'), q('notifuse:contacts.lire notifuse:contacts.ecrire'), q('notifuse:sequences.inscrire'), q('notifuse:contacts.ecrire notifuse:sequences.inscrire'), q('notifuse:autre.ecrire'), q()]).toEqual(['crm>notifuse', 'crm>notifuse', 'crm>notifuse#sequences', undefined, undefined, undefined]);
    expect([pairePour('crm', 'prospection', 'prospection:entreprise.lire')?.cle, pairePour('crm', 'prospection', 'prospection:exclusion.ecrire')]).toEqual(['crm>prospection', undefined]);
  });
  it('sourceServie : Prospection et Mail toujours ; le CRM et les autres, ouverts un à un', () => {
    const s = (x: 'crm' | 'academy' | 'prospection', v?: string, test = false) => sourceServie(x, { NODE_ENV: 'test', DELEGATION_SOURCES: v } as NodeJS.ProcessEnv, test);
    expect([s('prospection'), s('crm'), s('crm', 'crm'), s('crm', 'crm@test'), s('crm', 'crm@test', true), s('academy', 'crm')]).toEqual([true, false, true, false, true, false]);
  });
  it('cibleServie : fermé par défaut, nom exact', () => {
    expect([cibleServie('crm', env()), cibleServie('crm', env('')), cibleServie('crm', env('crm2')), cibleServie('crm', env('tous')), cibleServie('crm', env('notifuse, crm'))]).toEqual([false, false, false, false, true]);
  });
  it('paireServie : jamais un événement, même vers une cible ouverte', () => {
    const tout = env('crm,notifuse,prospection');
    expect(PAIRES.filter((p) => paireServie(p, tout)).map((p) => p.cle)).toEqual(['prospection>crm', 'prospection>notifuse']);
    expect(PAIRES.filter((p) => paireServie(p, { ...tout, DELEGATION_SOURCES: 'crm' })).map((p) => p.cle)).toEqual(['prospection>crm', 'prospection>notifuse', 'crm>notifuse', 'crm>notifuse#sequences', 'crm>prospection']);
    expect(paireServie(paire('notifuse>crm')!, tout)).toBe(false);
  });
  it('paireServie : « CRM vers Mail » sans source servie ne sert jamais, même cible ouverte ou organisation de test', () => {
    const p = paire('crm>notifuse')!;
    expect([paireServie(p, env('notifuse')), paireServie(p, env('notifuse@test'), true), paireReglable(p, 'T', env('notifuse'))]).toEqual([false, false, false]);
    expect(paireServie(paire('prospection>notifuse')!, env('notifuse')), 'témoin : même cible, autre source').toBe(true);
  });
  it('paireServie : une action vers une cible fermée ne sert pas', () => expect([paireServie(paire('prospection>crm')!, env()), paireServie(paire('prospection>crm')!, env('notifuse')), paireServie(paire('prospection>crm')!, env('crm'))]).toEqual([false, false, true]));
  it('evenementOuvert : vide = fermé ; tous, une organisation, ou marquées ; jamais par préfixe', () => {
    const e = (v?: string) => ({ NODE_ENV: 'test', DELEGATION_EVENEMENTS: v }) as NodeJS.ProcessEnv;
    const o = (v?: string, test = false, id = 'T') => evenementOuvert('notifuse>crm', id, e(v), test);
    expect([o(), o(''), o('notifuse>crm'), o('notifuse>crm@T'), o('notifuse>crm@T', false, 'T2'), o('notifuse>crm@test'), o('notifuse>crm@test', true), o('notifuse>crm2')]).toEqual([false, false, true, true, false, false, true, false]);
  });
  // Réglage servi en prod depuis le 26/11 (deploy/hub.nomad.hcl) : l'organisation de Robert ET les organisations de test, jamais un client de plus.
  it('evenementOuvert, réglage de prod : une organisation nommée plus les marquées de test, aucune autre', () => {
    const e = { NODE_ENV: 'test', DELEGATION_EVENEMENTS: 'notifuse>crm@359b76d5-bab7-4773-a889-cf4cf0248869,notifuse>crm@test' } as NodeJS.ProcessEnv;
    const o = (id: string, test: boolean) => evenementOuvert('notifuse>crm', id, e, test);
    expect([o('359b76d5-bab7-4773-a889-cf4cf0248869', false), o('ff6eaeff-274c-4115-8db0-e4de0c58c48b', true), o('20199a32-0000-4000-8000-000000000000', false)]).toEqual([true, true, false]);
    expect(paireReglable(paire('notifuse>crm')!, '20199a32-0000-4000-8000-000000000000', e)).toBe(false);
  });
  it('paireReglable : un événement ouvert se règle, sans jamais devenir une paire qui s\'échange', () => {
    const e = { NODE_ENV: 'test', DELEGATION_CIBLES: 'crm', DELEGATION_EVENEMENTS: 'notifuse>crm@T' } as NodeJS.ProcessEnv;
    const p = paire('notifuse>crm')!;
    expect([paireReglable(p, 'T', e), paireReglable(p, 'T2', e), paireServie(p, e), pairesServies(e).some((x) => x.cle === p.cle)]).toEqual([true, false, false, false]);
    expect(paireReglable(paire('prospection>crm')!, 'T2', e)).toBe(true);
  });
  it('cible@test : fermée sans compte de test, et ne vaut que pour cette cible', () => {
    const e = env('crm@test');
    expect([cibleServie('crm', e), cibleServie('crm', e, true), cibleServie('notifuse', e, true), pairesServies(e).length, pairesServies(e, true).map((p) => p.cle).join()]).toEqual([false, true, false, 0, 'prospection>crm']);
  });
  it('pairesServies : celles dont la cible est servie', () => {
    expect(pairesServies(env())).toEqual([]);
    expect(pairesServies(env('crm')).map((p) => p.cle)).toEqual(['prospection>crm']);
  });
  it('empreintePortees : change si on élargit, pas si on réordonne', () => {
    const p = paire('prospection>crm')!;
    expect(empreintePortees({ ...p, portees: [...p.portees].reverse() })).toBe(empreintePortees(p));
    expect(empreintePortees({ ...p, portees: [...p.portees, 'crm:personne.ecrire'] })).not.toBe(empreintePortees(p));
  });
  it('porteesAccordees : un sous-ensemble, jamais vide, en double, hors paire ou complet', () => {
    const p = paire('prospection>crm')!;
    expect([porteesAccordees(p, 'crm:tache.ecrire'), porteesAccordees(p, 'crm:societe.ecrire crm:tache.ecrire')]).toEqual(['crm:tache.ecrire', 'crm:societe.ecrire crm:tache.ecrire']);
    for (const x of [undefined, '', '  ', 'veridian', 'crm:societe.ecrire veridian', 'crm:societe.supprimer', 'crm:tache.ecrire crm:tache.ecrire']) expect(porteesAccordees(p, x), String(x)).toBeNull();
  });
  it('adresseAction : le MCP du CRM, la route d\'actions des autres, même origine', () => {
    expect(adresseAction('crm', 'https://crm.test/mcp')).toBe('https://crm.test/mcp');
    expect(adresseAction('notifuse', 'https://notifuse.app.veridian.site/api/mcp')).toBe('https://notifuse.app.veridian.site/api/veridian/actions');
  });
  it('CLE_MCP : chaque app a son adresse au registre', () => expect(CLE_MCP).toEqual({ crm: 'twenty', notifuse: 'notifuse', prospection: 'prospection', academy: 'academy', analytics: 'analytics' }));
});

describe('evenementOuvert (26/11)', () => {
  it('la liste entre guillemets se lit comme sans ; une clé à # ouvre sa seule paire, jamais la paire courte', () => {
    const env = { DELEGATION_EVENEMENTS: '"notifuse>crm@T1,notifuse>crm#activite@test"' } as NodeJS.ProcessEnv;
    expect([
      evenementOuvert('notifuse>crm', 'T1', env),
      evenementOuvert('notifuse>crm#activite', 'X', env, true),
      evenementOuvert('notifuse>crm', 'AUTRE', env, true),
      evenementOuvert('notifuse>crm', 'AUTRE', env),
    ]).toEqual([true, true, false, false]);
  });
});

