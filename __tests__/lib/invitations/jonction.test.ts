// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rejoindre: vi.fn() }));
vi.mock('@/lib/tenants/membres', async (o) => ({ ...(await o<object>()), rejoindre: (...a: unknown[]) => m.rejoindre(...a) }));

import { joindreParInvitation, tenantDeLInvitation } from '@/lib/invitations/jonction';
import { RefusMembre } from '@/lib/tenants/membres';

const EMISE = new Date('2026-11-24');
let membre: Record<string, unknown> | null;
let tenant: Record<string, unknown> | null;
const db = {
  user: { findUnique: async ({ where }: any) => (where.id === 'c-inv' ? { supabaseUserId: 'u-inv', email: 'inv@x.fr' } : null) },
  tenant: { findFirst: async ({ where }: any) => (where.notifuseWorkspaceSlug ? (where.notifuseWorkspaceSlug === 'esp' ? { id: 'T' } : null) : where.id === 'T' ? tenant : null) },
  tenantMember: { findUnique: async () => membre },
} as never;
const inv = (o = {}) => ({ id: 'i1', inviterUserId: 'c-inv', targetApp: 'notifuse', targetWorkspaceId: 'esp', createdAt: EMISE, ...o });
const app = (workspaces: unknown[]) => ({ fetchImpl: (async () => Response.json({ found: true, workspaces })) as unknown as typeof fetch });

beforeEach(() => {
  vi.clearAllMocks();
  m.rejoindre.mockResolvedValue({ cree: true, role: 'member' });
  membre = null;
  tenant = { userId: 'u-inv' };
  vi.stubEnv('PROSPECTION_API_URL', 'https://p.test');
  vi.stubEnv('PROSPECTION_HUB_API_SECRET', 's');
});

describe('joindreParInvitation', () => {
  it('invité par le propriétaire d\'un espace relié : membre, sans rôle choisi par l\'app', async () => {
    expect(await joindreParInvitation(db, inv(), 'u-new')).toEqual({ etat: 'joint', tenantId: 'T' });
    expect(m.rejoindre.mock.calls[0][1]).toEqual({ tenantId: 'T', hubUserId: 'u-new', origine: 'invitation', acteur: 'invitation:i1', emiseLe: EMISE });
  });

  it('un inviteur qui n\'est ni propriétaire ni admin AU HUB ne rend personne membre, quoi que dise l\'app', async () => {
    tenant = { userId: 'u-autre' };
    for (const x of [null, { role: 'member' }, { role: 'admin', deletedAt: new Date() }]) {
      membre = x;
      expect((await joindreParInvitation(db, inv(), 'u-new')).etat).toBe('inviteur_non_habilite');
    }
    expect((await joindreParInvitation(db, inv({ inviterUserId: 'c-forge' }), 'u-new')).etat).toBe('inviteur_non_habilite');
    expect(m.rejoindre).not.toHaveBeenCalled();
    membre = { role: 'admin', deletedAt: null };
    expect((await joindreParInvitation(db, inv(), 'u-new')).etat).toBe('joint');
  });

  it('espace relié à aucun tenant vivant : rien', async () => {
    expect((await joindreParInvitation(db, inv({ targetWorkspaceId: 'x' }), 'u')).etat).toBe('espace_non_relie');
    const p = inv({ targetApp: 'prospection', targetWorkspaceId: 'wp' });
    expect((await joindreParInvitation(db, p, 'u', app([{ workspace_id: 'autre', hub_tenant_id: 'T' }]))).etat).toBe('espace_non_relie');
    expect((await joindreParInvitation(db, p, 'u', app([{ workspace_id: 'wp', hub_tenant_id: 'T-mort' }]))).etat).toBe('espace_non_relie');
    expect((await joindreParInvitation(db, p, 'u', app([{ workspace_id: 'wp', hub_tenant_id: 'T' }]))).etat).toBe('joint');
  });

  it('un refus ou une panne se dit, et ne lève jamais', async () => {
    m.rejoindre.mockRejectedValue(new RefusMembre('adresse_non_prouvee'));
    expect(await joindreParInvitation(db, inv(), 'u')).toMatchObject({ etat: 'refus', detail: 'adresse_non_prouvee' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.rejoindre.mockRejectedValue(new Error('base'));
    expect(await joindreParInvitation(db, inv(), 'u')).toEqual({ etat: 'echec' });
    expect((await joindreParInvitation(db, inv({ targetApp: 'prospection' }), 'u', { fetchImpl: (async () => new Response('', { status: 500 })) as never })).etat).toBe('echec');
  });
});

describe('tenantDeLInvitation, avant de créer', () => {
  it('dit le tenant, ou pourquoi l\'invitation ne doit pas exister', async () => {
    expect(await tenantDeLInvitation(db, inv())).toEqual({ tenantId: 'T' });
    expect((await tenantDeLInvitation(db, inv({ targetWorkspaceId: 'x' }))).refus).toBe('espace_non_relie');
    expect((await tenantDeLInvitation(db, inv({ targetApp: 'cms' }))).refus).toBe('espace_non_relie');
    tenant = { userId: 'u-autre' };
    expect((await tenantDeLInvitation(db, inv())).refus).toBe('inviteur_non_habilite');
    expect((await tenantDeLInvitation(db, inv({ targetApp: 'prospection' }), { fetchImpl: (async () => new Response('', { status: 500 })) as never })).refus).toBe('echec');
  });
});
