// @vitest-environment node
/** Ouvrir un client : chaque app relue, jamais « créé » sur parole. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ abonner: vi.fn(async () => 'fait'), designer: vi.fn(async () => []), mail: vi.fn(), atlas: vi.fn(), crm: vi.fn(), academy: vi.fn(), presente: vi.fn(), vivant: vi.fn() }));
vi.mock('@/utils/tenants/provision', () => ({ provisionNotifuseTenant: (...a: unknown[]) => m.mail(...a), provisionProspectionTenant: (...a: unknown[]) => m.atlas(...a) }));
vi.mock('@/lib/crm/provision', () => ({ ensureCrmWorkspace: (...a: unknown[]) => m.crm(...a) }));
vi.mock('@/lib/academy/provision', () => ({ ensureAcademyWorkspace: (...a: unknown[]) => m.academy(...a) }));
vi.mock('@/lib/apps/presence', async (o) => ({ ...(await o<object>()), presenteDans: (...a: unknown[]) => m.presente(...a), espaceMailVivant: (...a: unknown[]) => m.vivant(...a) }));

vi.mock('@/lib/apps/admins-plateforme', () => ({ designerAdminsPlateforme: (...a: unknown[]) => m.designer(...a) }));
vi.mock('@/lib/evenements/naissance', () => ({ abonnerParDefaut: (...a: unknown[]) => m.abonner(...a) }));

import { ouvrirApps, verdict } from '@/lib/apps/ouvrir';

let t: any;
let u: any;
const db = { tenant: { findFirst: async () => t }, user: { findFirst: async () => u } } as never;
beforeEach(() => {
  vi.clearAllMocks();
  t = { id: 'T', userId: 'h', notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: {} };
  u = { email: 'a@x.fr', name: 'A', emailVerified: new Date(), supabaseUserId: 'h' };
  m.mail.mockImplementation(async () => { t = { ...t, notifuseWorkspaceSlug: 'ws' }; return { success: true }; });
  m.atlas.mockImplementation(async () => { t = { ...t, prospectionProvisionedAt: new Date() }; return { success: true }; });
  m.crm.mockImplementation(async () => { t = { ...t, metadata: { crm: { workspace_id: 'c' } } }; return { ok: true }; });
  m.presente.mockResolvedValue(true);
  m.vivant.mockResolvedValue(true);
});
const ouvrir = async (...apps: any[]) => { const r = (await ouvrirApps(db, 'T', apps))!; return [r.apps.map((x) => [x.app, x.etat]), r.verdict]; };

// 26/11 : une organisation née avant l'ouverture de l'événement « Mail vers CRM » n'avait jamais d'abonnement ; ses réponses étaient refusées 401.
describe('ouvrirApps : abonnement à l\'événement Mail vers CRM', () => {
  it('Mail ouvert : l\'abonnement par défaut est rattrapé ; Mail absent ou en échec : rien ; sa panne ne défait pas l\'ouverture', async () => {
    await ouvrirApps(db, 'T', ['notifuse']);
    expect(m.abonner).toHaveBeenCalledWith(db, 'T');
    m.abonner.mockClear();
    await ouvrirApps(db, 'T', ['prospection']);
    expect(m.abonner).not.toHaveBeenCalled();
    m.abonner.mockRejectedValueOnce(new Error('Mail muet'));
    expect((await ouvrirApps(db, 'T', ['notifuse']))!.verdict).toBe('complet');
  });
});

describe('ouvrirApps : administrateurs de plateforme', () => {
  it('Mail ouvert : posés admin avec l\'auteur donné ; Mail absent ou en échec : personne n\'est désigné', async () => {
    m.presente.mockResolvedValue(true);
    m.designer.mockResolvedValue([{ app: 'notifuse', hubUserId: 'r', etat: 'admin' }]);
    const r = (await ouvrirApps(db, 'T', ['notifuse'], { auteur: 'h-robert' }))!;
    expect(r.admins).toEqual([{ app: 'notifuse', hubUserId: 'r', etat: 'admin' }]);
    expect(m.designer.mock.calls[0][2]).toMatchObject({ acteur: 'h-robert' });
    m.designer.mockClear();
    await ouvrirApps(db, 'T', ['prospection']);
    m.mail.mockResolvedValue({ success: false, error: 'non' });
    t = { ...t, notifuseWorkspaceSlug: null };
    await ouvrirApps(db, 'T', ['notifuse']);
    expect(m.designer).not.toHaveBeenCalled();
  });
  it('sans auteur : l\'outil nommé par sa clé ; une panne de désignation ne défait pas l\'ouverture', async () => {
    m.presente.mockResolvedValue(true);
    m.designer.mockRejectedValue(new Error('panne'));
    const r = (await ouvrirApps(db, 'T', ['notifuse']))!;
    expect([r.verdict, r.admins, m.designer.mock.calls[0][2].acteur]).toEqual(['complet', [], 'cle:ADMIN_SECRET']);
  });
});

describe('ouvrirApps', () => {
  it('tout créé et relu : complet ; rejouée : rien n\'est recréé', async () => {
    expect(await ouvrir('notifuse', 'prospection', 'crm')).toEqual([[['notifuse', 'ouverte'], ['prospection', 'ouverte'], ['crm', 'ouverte']], 'complet']);
    await ouvrir('notifuse', 'prospection', 'crm');
    expect([m.mail, m.atlas, m.crm].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });
  it('« créé » mais l\'app ne l\'y voit pas : échec, jamais complet (25/11)', async () => {
    m.presente.mockImplementation(async (app: string) => app !== 'notifuse');
    expect(await ouvrir('notifuse', 'prospection')).toEqual([[['notifuse', 'echec'], ['prospection', 'ouverte']], 'non_abouti']);
  });
  it('« succès » sans espace noté : échec', async () => {
    m.atlas.mockResolvedValue({ success: true });
    expect(await ouvrir('prospection')).toEqual([[['prospection', 'echec']], 'non_abouti']);
  });
  it('relecture impossible : échec dit, pas « ouverte »', async () => { m.presente.mockResolvedValue(null); expect((await ouvrir('notifuse'))[1]).toBe('non_abouti'); });
  it('adresse pas prouvée : le CRM attend, nommé ; un espace créé où il n\'est pas encore relié attend aussi', async () => {
    u.emailVerified = null;
    m.presente.mockResolvedValue(false);
    expect(await ouvrir('notifuse', 'crm')).toEqual([[['notifuse', 'attente'], ['crm', 'attente']], 'en_partie']);
    expect(m.crm).not.toHaveBeenCalled();
  });
  it('adresse pas prouvée mais espace Mail supprimé ou illisible : échec, jamais « en attente » (25/11)', async () => {
    u.emailVerified = null;
    m.presente.mockResolvedValue(false);
    const rendu = [];
    for (const v of [false, null]) { m.vivant.mockResolvedValue(v); rendu.push((await ouvrirApps(db, 'T', ['notifuse']))!.apps[0]); }
    expect(rendu).toEqual([{ app: 'notifuse', etat: 'echec', detail: 'espace supprimé ou suspendu chez Mail' }, { app: 'notifuse', etat: 'echec', detail: 'relecture impossible' }]);
  });
  it('Analytics : pas d\'espace inventé ; une app qui plante n\'empêche pas les autres', async () => {
    m.mail.mockRejectedValue(new Error('réseau'));
    expect(await ouvrir('analytics', 'notifuse', 'prospection')).toEqual([[['analytics', 'attente'], ['notifuse', 'echec'], ['prospection', 'ouverte']], 'non_abouti']);
  });
  it('organisation ou personne inconnue : rien', async () => { t = null; expect(await ouvrirApps(db, 'T', ['notifuse'])).toBeNull(); });
});
it('verdict : l\'échec l\'emporte, rien d\'ouvert n\'est jamais complet', () => {
  expect([verdict([]), verdict([{ app: 'crm', etat: 'ouverte' }]), verdict([{ app: 'crm', etat: 'attente' }, { app: 'notifuse', etat: 'ouverte' }]), verdict([{ app: 'crm', etat: 'attente' }, { app: 'notifuse', etat: 'echec' }])]).toEqual(['non_abouti', 'complet', 'en_partie', 'non_abouti']);
});
