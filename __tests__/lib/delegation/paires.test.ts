// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CLE_MCP, cibleServie, empreintePortees, paire, paireEntre, PAIRES, pairesServies, porteesAccordees } from '@/lib/delegation/paires';

const env = (DELEGATION_CIBLES?: string) => ({ NODE_ENV: 'test', DELEGATION_CIBLES }) as NodeJS.ProcessEnv;

describe('registre des paires', () => {
  it('les cinq paires de départ, et aucune portée destructive ni complète', () => {
    expect(PAIRES.map((p) => p.cle)).toEqual(['prospection>crm', 'prospection>notifuse', 'notifuse>crm', 'crm>notifuse', 'crm>prospection']);
    for (const p of PAIRES) for (const x of p.portees) expect(x).toMatch(new RegExp(`^${p.cible}:[a-z]+\\.ecrire$`));
  });
  it('paire et paireEntre : seulement ce qui est inscrit', () => {
    expect(paire('crm>crm')).toBeUndefined();
    expect(paireEntre('notifuse', 'prospection')).toBeUndefined();
    expect(paireEntre('prospection', 'crm')?.cle).toBe('prospection>crm');
  });
  it('cibleServie : fermé par défaut, nom exact', () => {
    expect([cibleServie('crm', env()), cibleServie('crm', env('')), cibleServie('crm', env('crm2')), cibleServie('crm', env('tous')), cibleServie('crm', env('notifuse, crm'))]).toEqual([false, false, false, false, true]);
  });
  it('pairesServies : celles dont la cible est servie', () => {
    expect(pairesServies(env())).toEqual([]);
    expect(pairesServies(env('crm')).map((p) => p.cle)).toEqual(['prospection>crm', 'notifuse>crm']);
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
  it('CLE_MCP : chaque app a son adresse au registre', () => expect(CLE_MCP).toEqual({ crm: 'twenty', notifuse: 'notifuse', prospection: 'prospection' }));
});
