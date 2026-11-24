// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { confirmerDemande, couperIntegrations, lireDemande, listerIntegrations, reglerIntegration } from '@/lib/delegation/interrupteur';
import { empreintePortees, paire } from '@/lib/delegation/paires';

import { base } from './fausse';

const ENV = { NODE_ENV: 'test', DELEGATION_CIBLES: 'crm' } as NodeJS.ProcessEnv;
const P = 'prospection>crm';
let db: ReturnType<typeof base>;
beforeEach(() => {
  db = base();
  db.tenant.lignes.push({ id: 'A', userId: 'prop', status: 'active', name: 'Atelier' }, { id: 'B', userId: 'autre', status: 'active', name: 'B' });
  for (const [u, role] of [['adm', 'admin'], ['mem', 'member']]) db.tenantMember.lignes.push({ tenantId: 'A', userId: u, role });
  for (const u of ['prop', 'adm', 'mem', 'autre']) db.user.lignes.push({ supabaseUserId: u, email: `${u}@x.fr` });
});
const regler = (hubUserId: string, etat: 'allumee' | 'eteinte', o: object = {}) => reglerIntegration(db as never, { tenantId: 'A', paire: P, etat, hubUserId, client: 'ChatGPT', origine: 'https://hub.test', ...o }, ENV);
const jetonDe = (r: any): string => String(r.lien).split('/').pop()!;
const etat = async () => (await listerIntegrations(db as never, 'A', ENV)).find((x) => x.paire === P)!;

describe('régler', () => {
  it('première ouverture : un lien, rien n\'est allumé ; le propriétaire confirme ; ensuite l\'IA coupe et rallume', async () => {
    const r = await regler('adm', 'allumee');
    expect(r).toMatchObject({ etat: 'a_confirmer', lien: expect.stringMatching(/^https:\/\/hub\.test\/liaisons\/confirmer\/[A-Za-z0-9_-]{43}$/) });
    expect((await etat()).etat).toBe('eteinte');
    expect(JSON.stringify(db.integrationDemande.lignes)).not.toContain(jetonDe(r));
    expect(await confirmerDemande(db as never, jetonDe(r), 'prop', ENV)).toEqual({ ok: true, paire: P, tenantId: 'A' });
    expect(await etat()).toMatchObject({ etat: 'allumee', consentie: true, change_par: 'prop@x.fr via le Hub' });
    expect(await regler('adm', 'eteinte')).toEqual({ etat: 'eteinte' });
    expect(await regler('adm', 'allumee')).toEqual({ etat: 'allumee' });
    expect((await etat()).change_par).toBe('adm@x.fr via ChatGPT');
  });
  it('le clic : usage unique, propriétaire seulement, quinze minutes', async () => {
    const j = jetonDe(await regler('adm', 'allumee'));
    for (const u of ['adm', 'mem', 'autre', 'inconnu']) expect(await confirmerDemande(db as never, j, u, ENV), u).toEqual({ ok: false });
    expect((await etat()).etat).toBe('eteinte');
    expect((await confirmerDemande(db as never, j, 'prop', ENV)).ok).toBe(true);
    expect((await confirmerDemande(db as never, j, 'prop', ENV)).ok, 'rejoué').toBe(false);
    const k = jetonDe(await regler('adm', 'allumee', { paire: 'notifuse>crm' }));
    db.integrationDemande.lignes.at(-1)!.expireLe = new Date(Date.now() - 1);
    expect((await confirmerDemande(db as never, k, 'prop', ENV)).ok, 'expiré').toBe(false);
    expect(await lireDemande(db as never, 'x', 'prop', ENV)).toBeNull();
  });
  it('un membre, un étranger, un retiré, un tenant suspendu : refus, rien d\'écrit, même pour éteindre', async () => {
    db.tenantMember.lignes.push({ tenantId: 'A', userId: 'parti', role: 'owner', deletedAt: new Date() });
    for (const u of ['mem', 'autre', 'parti']) for (const e of ['allumee', 'eteinte'] as const) expect(await regler(u, e)).toEqual({ refus: 'role_insuffisant' });
    db.tenant.lignes[0].status = 'suspended';
    expect(await regler('prop', 'allumee')).toEqual({ refus: 'role_insuffisant' });
    expect([db.integrationPaire.lignes, db.integrationDemande.lignes]).toEqual([[], []]);
  });
  it('paire inconnue, cible non servie', async () => {
    expect(await regler('prop', 'allumee', { paire: 'crm>crm' })).toEqual({ refus: 'paire_inconnue' });
    expect(await regler('prop', 'allumee', { paire: 'crm>notifuse' })).toEqual({ refus: 'cible_non_servie' });
  });
  it('élargir une portée redemande le clic', async () => {
    db.integrationPaire.lignes.push({ tenantId: 'A', paire: P, etat: 'eteinte', consentiLe: new Date(), portees: 'ancienne', changePar: 'prop', changeLe: new Date() });
    expect((await regler('prop', 'allumee') as any).etat).toBe('a_confirmer');
    db.integrationPaire.lignes[0].etat = 'allumee';
    expect((await etat()).etat, 'allumée sans consentement valable : montrée éteinte').toBe('eteinte');
  });
});

describe('lister, lire, couper', () => {
  it('toutes les paires, l\'état vrai, aucune donnée d\'un autre tenant', async () => {
    db.integrationPaire.lignes.push({ tenantId: 'B', paire: P, etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(paire(P)!), changePar: 'autre', changeLe: new Date() });
    const l = await listerIntegrations(db as never, 'A', ENV);
    expect(l.map((x) => [x.paire, x.etat])).toEqual([[P, 'eteinte'], ['prospection>notifuse', 'indisponible'], ['notifuse>crm', 'eteinte'], ['crm>notifuse', 'indisponible'], ['crm>prospection', 'indisponible']]);
    expect(JSON.stringify(l)).not.toContain('autre@x.fr');
  });
  it('la page montre qui, quoi, où', async () => {
    const j = jetonDe(await regler('adm', 'allumee'));
    expect(await lireDemande(db as never, j, 'prop', ENV)).toMatchObject({ espace: 'Atelier', client: 'ChatGPT', demandePar: 'adm@x.fr', portees: ['crm:societe.ecrire', 'crm:tache.ecrire'] });
  });
  it('suspension : consentement retiré, seulement dans ce tenant', async () => {
    for (const tenantId of ['A', 'B']) db.integrationPaire.lignes.push({ tenantId, paire: P, etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(paire(P)!), changePar: 'prop', changeLe: new Date() });
    expect(await couperIntegrations(db as never, 'A')).toBe(1);
    expect((await etat()).consentie).toBe(false);
    expect((await regler('prop', 'allumee') as any).etat, 'la reprise redemande le clic').toBe('a_confirmer');
    expect(db.integrationPaire.lignes.find((x) => x.tenantId === 'B')!.consentiLe).toBeTruthy();
  });
});
