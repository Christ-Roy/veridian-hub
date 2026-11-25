// @vitest-environment node
/** Ouvrir un client : chaque app relue, jamais « créé » sur parole. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ mail: vi.fn(), atlas: vi.fn(), crm: vi.fn(), academy: vi.fn(), presente: vi.fn() }));
vi.mock('@/utils/tenants/provision', () => ({ provisionNotifuseTenant: (...a: unknown[]) => m.mail(...a), provisionProspectionTenant: (...a: unknown[]) => m.atlas(...a) }));
vi.mock('@/lib/crm/provision', () => ({ ensureCrmWorkspace: (...a: unknown[]) => m.crm(...a) }));
vi.mock('@/lib/academy/provision', () => ({ ensureAcademyWorkspace: (...a: unknown[]) => m.academy(...a) }));
vi.mock('@/lib/apps/presence', async (o) => ({ ...(await o<object>()), presenteDans: (...a: unknown[]) => m.presente(...a) }));

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
});
const ouvrir = async (...apps: any[]) => { const r = (await ouvrirApps(db, 'T', apps))!; return [r.apps.map((x) => [x.app, x.etat]), r.verdict]; };

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
  it('Analytics : pas d\'espace inventé ; une app qui plante n\'empêche pas les autres', async () => {
    m.mail.mockRejectedValue(new Error('réseau'));
    expect(await ouvrir('analytics', 'notifuse', 'prospection')).toEqual([[['analytics', 'attente'], ['notifuse', 'echec'], ['prospection', 'ouverte']], 'non_abouti']);
  });
  it('organisation ou personne inconnue : rien', async () => { t = null; expect(await ouvrirApps(db, 'T', ['notifuse'])).toBeNull(); });
});
it('verdict : l\'échec l\'emporte, rien d\'ouvert n\'est jamais complet', () => {
  expect([verdict([]), verdict([{ app: 'crm', etat: 'ouverte' }]), verdict([{ app: 'crm', etat: 'attente' }, { app: 'notifuse', etat: 'ouverte' }]), verdict([{ app: 'crm', etat: 'attente' }, { app: 'notifuse', etat: 'echec' }])]).toEqual(['non_abouti', 'complet', 'en_partie', 'non_abouti']);
});
