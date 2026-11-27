/** Connexion obligatoire (VER-261) : ce qu'une preuve ouvre, ce qu'elle n'ouvre pas, et l'accès gardé qui tombe. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: vi.fn(async () => ({})) }));

import { pushUserToApps } from '@/lib/identity/push-user';
import { aiguiller, etatConnexion, leverExemption, poserExemption, reglerConnexion } from '@/lib/federation/connexion';
import { glisser, preuvesVivantes } from '@/lib/federation/duree';
import { fermees, noterPassage, orgsProuvees, preuveDeSession, tientApp } from '@/lib/federation/obligation';

const ORG = '11111111-1111-4111-8111-111111111111';
const AUTRE = '22222222-2222-4222-8222-222222222222';
const MOI = '33333333-3333-4333-8333-333333333333';
const PATRON = '44444444-4444-4444-8444-444444444444';
const NOW = 1_800_000_000_000;
const S = NOW / 1000;

type L = Record<string, any>;
function base(o: { obligatoire?: boolean; actif?: boolean; relie?: boolean; exemption?: L | null; passage?: L | null; idpId?: string; jours?: number | null } = {}) {
  const etat = { regle: { tenantId: ORG, obligatoire: o.obligatoire ?? true, aiguillage: ['exemple.fr'], majPar: 'x', majLe: new Date(NOW) } as L | null, x: (o.exemption ?? null) as L | null, p: (o.passage ?? null) as L | null };
  const idp = { id: o.idpId ?? 'idp1', tenantId: ORG, issuer: 'https://login.infomaniak.com', alias: 'exemple', actif: o.actif ?? true, sessionJours: o.jours === undefined ? 7 : o.jours };
  const tenants = [{ id: ORG, name: 'Exemple', slug: 'exemple-1', userId: PATRON, status: 'active', deletedAt: null, metadata: null as unknown }, { id: AUTRE, name: 'À moi', slug: 'moi', userId: MOI, status: 'active', deletedAt: null, metadata: null as unknown }];
  const db = {
    tenantConnexion: {
      findMany: vi.fn(async () => (etat.regle?.obligatoire ? [{ tenantId: ORG }] : [])),
      findUnique: vi.fn(async () => etat.regle),
      findFirst: vi.fn(async ({ where }: L) => {
        if (!etat.regle) return null;
        if (where.tenantId && where.tenantId !== ORG) return null;
        if (where.obligatoire && !etat.regle.obligatoire) return null;
        if (where.aiguillage?.has && !etat.regle.aiguillage.includes(where.aiguillage.has)) return null;
        if (where.aiguillage?.hasSome) return where.NOT?.tenantId === ORG ? null : etat.regle;
        return etat.regle;
      }),
      upsert: vi.fn(async ({ update }: L) => { etat.regle = { ...etat.regle, ...update }; }),
    },
    tenantMember: { findMany: vi.fn(async ({ where }: L) => (where.userId === undefined ? [{ userId: MOI, role: 'member' }] : where.userId === MOI ? [{ tenantId: ORG }] : [])), findFirst: vi.fn(async ({ where }: L) => (where.userId === MOI ? { tenantId: ORG } : null)) },
    tenant: {
      findMany: vi.fn(async ({ where }: L) => tenants.filter((t) => where.id.in.includes(t.id) && (t.userId === where.OR[0].userId || where.OR[1].id.in.includes(t.id)))),
      findFirst: vi.fn(async ({ where }: L) => tenants.find((t) => t.id === where.id && (!where.userId || t.userId === where.userId)) ?? null),
    },
    tenantIdp: { findUnique: vi.fn(async () => idp) },
    account: { findFirst: vi.fn(async ({ where }: L) => (o.relie && where.provider === `org:${idp.id}` ? { id: 'a' } : null)), findMany: vi.fn(async () => (o.relie ? [{ userId: 'u1' }] : [])) },
    connexionExemption: {
      findUnique: vi.fn(async ({ where }: L) => (etat.x && where.tenantId_hubUserId.hubUserId === etat.x.hubUserId ? etat.x : null)),
      findMany: vi.fn(async ({ where }: L) => (etat.x && (!where.nature || where.nature === etat.x.nature) && (where.leveLe === undefined || etat.x.leveLe === null) ? [etat.x] : [])),
      updateMany: vi.fn(async ({ where, data }: L) => { if (etat.x && !etat.x.leveLe && (!where.nature || where.nature === etat.x.nature)) { etat.x = { ...etat.x, ...data }; return { count: 1 }; } return { count: 0 }; }),
      upsert: vi.fn(async ({ create }: L) => { etat.x = create; }),
    },
    connexionPreuve: { findUnique: vi.fn(async () => etat.p), upsert: vi.fn(async ({ create }: L) => { etat.p = create; }) },
    organisation: { findUnique: vi.fn(async () => null as L | null) },
    tenantApp: { findFirst: vi.fn(async () => null as L | null) },
    user: { findMany: vi.fn(async () => [{ id: 'u1', email: 'moi@exemple.fr', supabaseUserId: MOI }, { id: 'u2', email: 'patron@exemple.fr', supabaseUserId: PATRON }]) },
    auditLog: {},
  };
  return { db: db as any, etat, tenants };
}
const ids = async (b: ReturnType<typeof base>, p: any, qui = MOI) => (await fermees(b.db, qui, p, NOW)).map((f) => f.tenantId);
const preuve = (d: Partial<{ le: number; vu: number; i: string }> = {}) => ({ par: 'session' as const, preuves: { [ORG]: { le: S - 60, vu: S - 60, i: 'idp1', j: 7, ...d } } });
const vive = (nature: string, hubUserId = MOI) => ({ tenantId: ORG, hubUserId, nature, posePar: 'x', poseLe: new Date(NOW), leveLe: null as Date | null });

describe('fermees', () => {
  it('libre : rien ne change, et une seule lecture', async () => {
    const b = base({ obligatoire: false });
    expect(await ids(b, { par: 'session' })).toEqual([]);
    expect(b.db.tenant.findMany).not.toHaveBeenCalled();
  });
  it('une session par mot de passe ou Google n\'ouvre pas l\'organisation, même reliée ; les autres restent ouvertes', async () => {
    expect(await ids(base({ relie: true }), { par: 'session' })).toEqual([ORG]);
    expect(await ids(base({ relie: false }), { par: 'session' })).toEqual([ORG]);
  });
  it('ouverte par le fournisseur, ou passée par lui', async () => {
    expect(await ids(base({ relie: true }), { par: 'session', federeOrg: ORG })).toEqual([]);
    expect(await ids(base({ relie: true }), preuve())).toEqual([]);
  });
  it('un passage par une AUTRE organisation, un autre fournisseur, trop vieux, ou sans lien, n\'ouvre pas', async () => {
    expect(await ids(base({ relie: true }), { par: 'session', federeOrg: AUTRE })).toEqual([ORG]);
    expect(await ids(base({ relie: true }), preuve({ i: 'ancien' }))).toEqual([ORG]);
    expect(await ids(base({ relie: true }), preuve({ le: S - 8 * 86_400, vu: S - 8 * 86_400 }))).toEqual([ORG]);
    expect(await ids(base({ relie: true }), preuve({ le: S - 31 * 86_400, vu: S - 10 }))).toEqual([ORG]);
    expect(await ids(base({ relie: false }), preuve())).toEqual([ORG]);
    expect(await ids(base({ relie: false }), { par: 'session', federeOrg: ORG })).toEqual([ORG]);
  });
  it('fournisseur coupé : fermée, sauf accès de secours', async () => {
    expect(await ids(base({ relie: true, actif: false }), preuve())).toEqual([ORG]);
    expect(await ids(base({ actif: false, exemption: vive('secours') }), { par: 'session' })).toEqual([]);
  });
  it('accès gardé jusqu\'au rattachement : ouvre, puis tombe dès qu\'elle est reliée, même si la ligne n\'a pas suivi', async () => {
    expect(await ids(base({ exemption: vive('rattachement') }), { par: 'session' })).toEqual([]);
    expect(await ids(base({ relie: true, exemption: vive('rattachement') }), { par: 'session' })).toEqual([ORG]);
    expect(await ids(base({ exemption: { ...vive('rattachement'), leveLe: new Date(NOW) } }), { par: 'session' })).toEqual([ORG]);
    expect(await ids(base({ relie: true, exemption: vive('secours') }), { par: 'session' })).toEqual([]);
  });
  it('l\'accès gardé de l\'un n\'ouvre pas à l\'autre', async () => {
    expect(await ids(base({ exemption: vive('secours', PATRON) }), { par: 'session' })).toEqual([ORG]);
  });
  it('jeton d\'IA : l\'organisation prouvée à sa remise ET un passage de moins de 30 jours chez ce fournisseur', async () => {
    const passage = { idpId: 'idp1', le: new Date(NOW - 86_400_000) };
    expect(await ids(base({ relie: true, passage }), { par: 'jeton', orgs: [ORG] })).toEqual([]);
    expect(await ids(base({ relie: true, passage }), { par: 'jeton', orgs: [] })).toEqual([ORG]);
    expect(await ids(base({ relie: true, passage: { ...passage, le: new Date(NOW - 31 * 86_400_000) } }), { par: 'jeton', orgs: [ORG] })).toEqual([ORG]);
    expect(await ids(base({ relie: true, passage: { ...passage, idpId: 'ancien' } }), { par: 'jeton', orgs: [ORG] })).toEqual([ORG]);
    expect(await ids(base({ relie: true, passage: null }), { par: 'personne' })).toEqual([ORG]);
    expect(await ids(base({ relie: true, passage }), { par: 'personne' })).toEqual([]);
  });
  it('une lecture ratée lève : jamais ouverte par erreur', async () => {
    const b = base();
    b.db.tenantConnexion.findMany.mockRejectedValueOnce(new Error('base'));
    await expect(fermees(b.db, MOI, { par: 'session' })).rejects.toThrow('base');
  });
  it('une session d\'emprunt ne porte aucune preuve', () => {
    expect(preuveDeSession({ user: { federeOrg: ORG, preuves: preuve().preuves, impersonated: true } })).toEqual({ par: 'session' });
  });
});

describe('preuves portées par la session', () => {
  it('glissent une fois par heure, meurent avec leur durée, jamais plus de cinq', () => {
    const t = glisser({ preuves: { [ORG]: { le: S - 7_200, vu: S - 7_200, i: 'idp1', j: 7 } } } as any, S) as any;
    expect(t.preuves[ORG]).toEqual({ le: S - 7_200, vu: S, i: 'idp1', j: 7 });
    expect(preuvesVivantes({ a: { le: S - 90_000, vu: S, i: 'x' } }, S)).toBeUndefined();
    expect(preuvesVivantes({ a: { le: 'x' }, b: null }, S)).toBeUndefined();
    expect(Object.keys(preuvesVivantes(Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`o${n}`, { le: S - n, vu: S - n, i: 'x' }])), S)!)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
  });
  it('un jeton n\'emporte que ce que la session a prouvé, jamais une session d\'un autre fournisseur', async () => {
    const b = base({ relie: true });
    expect(await orgsProuvees(b.db, preuve(), NOW)).toEqual([ORG]);
    expect(await orgsProuvees(b.db, preuve({ i: 'ancien' }), NOW)).toEqual([]);
    expect(await orgsProuvees(b.db, { par: 'personne' }, NOW)).toEqual([]);
  });
});

describe('noterPassage', () => {
  it('l\'accès gardé tombe pour de bon, l\'accès de secours reste', async () => {
    const b = base({ exemption: vive('rattachement') });
    await noterPassage(b.db, { id: 'idp1', tenantId: ORG }, MOI, new Date(NOW));
    expect(b.etat.x?.leveLe).toEqual(new Date(NOW));
    const s = base({ exemption: vive('secours') });
    await noterPassage(s.db, { id: 'idp1', tenantId: ORG }, MOI, new Date(NOW));
    expect(s.etat.x?.leveLe).toBeNull();
  });
});

describe('reglerConnexion', () => {
  it('refuse sans fournisseur actif, sans accès de secours', async () => {
    expect(await reglerConnexion(base({ obligatoire: false, actif: false }).db, { tenantId: ORG, obligatoire: true, acteur: 'x' })).toEqual({ refus: 'fournisseur_absent' });
    expect(await reglerConnexion(base({ obligatoire: false }).db, { tenantId: ORG, obligatoire: true, acteur: 'x' })).toEqual({ refus: 'secours_manquant' });
    // Un accès de secours dont la personne n'est plus membre n'ouvre rien : il ne compte pas.
    expect(await reglerConnexion(base({ obligatoire: false, exemption: vive('secours', 'parti') }).db, { tenantId: ORG, obligatoire: true, acteur: 'x' })).toEqual({ refus: 'secours_manquant' });
  });
  it('coupe les sessions d\'app de ceux qu\'elle ferme, jamais des exemptés', async () => {
    vi.mocked(pushUserToApps).mockClear();
    const r = await reglerConnexion(base({ obligatoire: false, exemption: vive('secours', PATRON) }).db, { tenantId: ORG, obligatoire: true, acteur: 'x' });
    expect(r).toEqual({ ok: true, coupes: [MOI] });
    expect(vi.mocked(pushUserToApps).mock.calls.map((c) => c[0])).toEqual([{ hubUserId: MOI, revokeSessions: true }]);
  });
  it('le propriétaire qui l\'active devient l\'accès de secours, à défaut d\'un autre ; libre rouvre tout', async () => {
    const b = base({ obligatoire: false });
    expect(await reglerConnexion(b.db, { tenantId: ORG, obligatoire: true, acteur: 'x', proprietaire: PATRON })).toMatchObject({ ok: true });
    expect(b.etat.x).toMatchObject({ hubUserId: PATRON, nature: 'secours' });
    await reglerConnexion(b.db, { tenantId: ORG, obligatoire: false, acteur: 'x' });
    expect(await ids(b, { par: 'session' })).toEqual([]);
  });
  it('domaine d\'aiguillage : ni public, ni le nôtre, ni celui d\'une autre organisation', async () => {
    const b = base();
    expect(await reglerConnexion(b.db, { tenantId: ORG, aiguillage: ['gmail.com'], acteur: 'x' })).toEqual({ refus: 'domaine_public' });
    expect(await reglerConnexion(b.db, { tenantId: ORG, aiguillage: ['e2e.veridian.site'], acteur: 'x' })).toEqual({ refus: 'domaine_veridian' });
    expect(await reglerConnexion(b.db, { tenantId: AUTRE, aiguillage: ['exemple.fr'], acteur: 'x' })).toEqual({ refus: 'domaine_pris' });
  });
});

describe('accès gardés', () => {
  it('le dernier accès de secours ne s\'enlève pas, ni ne se rétrograde', async () => {
    const b = base({ exemption: vive('secours') });
    expect(await leverExemption(b.db, { tenantId: ORG, hubUserId: MOI, acteur: 'x' })).toEqual({ refus: 'dernier_secours' });
    expect(await poserExemption(b.db, { tenantId: ORG, hubUserId: MOI, nature: 'rattachement', acteur: 'x' })).toEqual({ refus: 'dernier_secours' });
    expect(await leverExemption(base({ obligatoire: false, exemption: vive('secours') }).db, { tenantId: ORG, hubUserId: MOI, acteur: 'x' })).toEqual({ ok: true });
  });
  it('seulement à un membre, et jamais « jusqu\'au rattachement » à qui l\'est déjà', async () => {
    expect(await poserExemption(base().db, { tenantId: ORG, hubUserId: 'etranger', nature: 'secours', acteur: 'x' })).toEqual({ refus: 'pas_membre' });
    expect(await poserExemption(base({ relie: true }).db, { tenantId: ORG, hubUserId: MOI, nature: 'rattachement', acteur: 'x' })).toEqual({ refus: 'deja_reliee' });
  });
  it('l\'état dit qui entre comment', async () => {
    const e = await etatConnexion(base({ exemption: vive('rattachement') }).db, ORG);
    expect(e.personnes.map((p) => [p.email, p.role, p.acces])).toEqual([['patron@exemple.fr', 'owner', 'ferme'], ['moi@exemple.fr', 'member', 'actuel']]);
  });
});

describe('aiguiller', () => {
  it('par le domaine seul, seulement en obligatoire et fournisseur actif ; aucun compte lu', async () => {
    const b = base();
    expect(await aiguiller(b.db, 'Inconnu@Exemple.fr')).toEqual({ tenantId: ORG, porte: 'exemple' });
    expect(await aiguiller(b.db, 'x@autre.fr')).toBeNull();
    expect(await aiguiller(b.db, 'x@sous.exemple.fr')).toBeNull();
    expect(await aiguiller(b.db, 'a@b@exemple.fr')).toBeNull();
    expect(await aiguiller(base({ obligatoire: false }).db, 'x@exemple.fr')).toBeNull();
    expect(await aiguiller(base({ actif: false }).db, 'x@exemple.fr')).toBeNull();
    expect(b.db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('tientApp', () => {
  const f = { tenantId: ORG, nom: 'x', fournisseur: 'x', porte: 'x', proprietaire: false };
  it('une app que l\'organisation n\'a pas reste ouverte ; au moindre indice, fermée', async () => {
    const b = base();
    expect(await tientApp(b.db, f, 'notifuse')).toBe(false);
    expect(await tientApp(b.db, { ...f, proprietaire: true }, 'notifuse')).toBe(true);
    b.db.organisation.findUnique.mockResolvedValueOnce({ modules: ['crm'] });
    expect(await tientApp(b.db, f, 'crm')).toBe(true);
    b.tenants[0].metadata = { twenty: { workspace_id: 'w' } };
    expect(await tientApp(b.db, f, 'crm')).toBe(true);
    expect(await tientApp(b.db, f, 'academy')).toBe(false);
    b.db.tenantApp.findFirst.mockResolvedValueOnce({ appKey: 'cms' });
    expect(await tientApp(b.db, f, 'cms')).toBe(true);
  });
});
