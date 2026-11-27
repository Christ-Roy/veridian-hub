// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import { contenuOrg, COULEUR, documentOrg, MODULES, pourApp, TYPES, urlLogo } from '@/lib/organisations/document';

import { base } from './fausse';

let db: ReturnType<typeof base>;
const T0 = new Date('2026-01-01');
beforeEach(() => {
  db = base();
  db.tenant.lignes.push({ id: 'A', userId: 'prop', name: 'Atelier', status: 'active', createdAt: T0 });
  db.user.lignes.push({ supabaseUserId: 'prop', email: 'Prop@x.fr', name: 'P', emailVerified: T0 }, { supabaseUserId: 'm', email: 'm@x.fr', name: null, emailVerified: T0 }, { supabaseUserId: 'np', email: 'np@x.fr', name: null, emailVerified: null });
  db.tenantMember.lignes.push({ tenantId: 'A', userId: 'm', role: 'admin', joinedAt: new Date('2026-02-01') }, { tenantId: 'A', userId: 'np', role: 'member', joinedAt: T0 }, { tenantId: 'A', userId: 'parti', role: 'member', joinedAt: T0, deletedAt: T0 });
  db.organisation.lignes.push({ tenantId: 'A', type: 'organisation', nomAffiche: null, couleurPrimaire: '#0B5FFF', couleurAccent: null, logoEmpreinte: 'abc', modules: ['academy'], reglages: { academy: { mode_rs: true }, autre: { x: 1 } }, version: BigInt(0), empreinte: null });
});
const doc = () => documentOrg(db as never, 'A', 'https://hub.test');

describe('documentOrg', () => {
  it('nom, marque, logo versionné ; propriétaire et membres prouvés, jamais un retiré ni une adresse non prouvée', async () => {
    const d = (await doc())!;
    expect(d).toMatchObject({ hub_tenant_id: 'A', nom: 'Atelier', type: 'organisation', modules: ['academy'], marque: { nom_affiche: null, logo_url: 'https://hub.test/api/public/org/A/logo?v=abc', couleur_primaire: '#0B5FFF', couleur_accent: null } });
    expect(d.membres).toEqual([
      { hub_user_id: 'm', email: 'm@x.fr', email_proven: true, name: null, role: 'admin', joined_at: '2026-02-01T00:00:00.000Z' },
      { hub_user_id: 'prop', email: 'prop@x.fr', email_proven: true, name: 'P', role: 'owner', joined_at: T0.toISOString() },
    ]);
  });
  it('un nom affiché est CHOISI ou absent : le nom par défaut du compte ne part jamais comme une marque', async () => {
    expect((await doc())!.marque.nom_affiche).toBeNull();
    db.organisation.lignes[0].nomAffiche = 'Veridian';
    expect((await doc())!).toMatchObject({ nom: 'Veridian', marque: { nom_affiche: 'Veridian' } });
  });
  it('la version ne bouge que si le contenu bouge, et ne recule jamais', async () => {
    const v1 = (await doc())!.version;
    expect((await doc())!.version).toBe(v1);
    db.organisation.lignes[0].version = BigInt(Date.now() + 9e9);
    db.organisation.lignes[0].couleurAccent = '#FFB000';
    const v2 = (await doc())!.version;
    expect(v2).toBe(Number(db.organisation.lignes[0].version));
    expect(v2).toBeGreaterThan(v1);
  });
  it('non réglée, suspendue ou supprimée : aucun document, donc rien n\'est émis', async () => {
    db.tenant.lignes[0].status = 'suspended';
    expect(await doc()).toBeNull();
    db.tenant.lignes[0].status = 'active';
    db.organisation.lignes.length = 0;
    expect(await doc()).toBeNull();
  });
});
it('pourApp : une app ne reçoit que ses réglages ; MODULES : Academy, Mail et Prospection ; urlLogo : nul sans logo', async () => {
  expect(pourApp((await doc())!, 'academy').reglages).toEqual({ academy: { mode_rs: true } });
  expect(pourApp((await doc())!, 'crm').reglages).toEqual({});
  expect([...MODULES]).toEqual(['academy', 'notifuse', 'prospection', 'crm', 'analytics']);
  expect(urlLogo('https://h', { tenantId: 'A', logoEmpreinte: null })).toBeNull();
});
it('COULEUR : six chiffres hexadécimaux, rien d\'autre', () => expect(['#0B5FFF', '#0b5fff', '#FFF', '0B5FFF', '#0B5FFF;', 'url(x)', '#0B5FFG'].map((c) => COULEUR.test(c))).toEqual([true, true, false, false, false, false, false]));
it('TYPES : deux, et un type inconnu en base vaut individuel', async () => {
  expect([...TYPES]).toEqual(['individuel', 'organisation']);
  db.organisation.lignes[0].type = 'bizarre';
  expect((await doc())!.type).toBe('individuel');
});

describe('contenuOrg', () => {
  it('calcule l\'empreinte sans rien écrire : la version stockée ne bouge pas', async () => {
    const c = (await contenuOrg(db as never, 'A', 'https://hub.test'))!;
    expect(c.empreinte).not.toBe(c.empreinteStockee);
    expect(db.organisation.lignes[0].version).toBe(BigInt(0));
    expect(db.organisation.lignes[0].empreinte).toBeNull();
    expect(c.contenu).not.toHaveProperty('version');
  });
});

it('le CRM est une app qui PEUT recevoir, jamais une app cochée d\'office (VER-252)', async () => {
  expect(MODULES).toContain('crm');
  expect((await doc())!.modules).not.toContain('crm');
});
