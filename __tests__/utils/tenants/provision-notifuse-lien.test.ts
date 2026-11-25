/**
 * Un espace Notifuse neuf est relié au tenant Hub (tenant_id du JWT MCP) : Notifuse ne retient ce
 * lien qu'à l'update-plan. Jamais pour un espace existant (l'update-plan free y rétrograderait).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provisionWorkspace = vi.fn();
const updatePlan = vi.fn(async () => undefined);
const tenantLu = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
const tenantEcrit = vi.fn(async (..._a: unknown[]) => ({ id: 't-hub' }));
vi.mock('@/lib/notifuse/client', () => ({ NotifuseClient: class { provisionWorkspace = provisionWorkspace; updatePlan = updatePlan; } }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async () => ({ id: 't-hub', metadata: {} })),
      findUnique: (...a: unknown[]) => tenantLu(...a),
      create: vi.fn(async () => ({ id: 't-hub' })),
      update: (...a: unknown[]) => tenantEcrit(...a),
    },
    provisioningLog: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock('@/lib/auth/email-proof-provider', () => ({ isEmailProvenInDb: vi.fn(async () => true) }));
vi.mock('@/utils/tenants/debug', () => ({ logProvisionStart: vi.fn(), logProvisionEnd: vi.fn(), logStep: vi.fn(), logError: vi.fn() }));

beforeEach(() => {
  process.env.NOTIFUSE_API_URL = 'https://notifuse.test';
  process.env.NOTIFUSE_HUB_API_SECRET = 's';
  provisionWorkspace.mockReset();
  updatePlan.mockClear();
  tenantEcrit.mockClear();
  tenantLu.mockReset().mockResolvedValue(null);
});

describe('provisionNotifuseTenant : lien au tenant Hub', () => {
  it('espace neuf : update-plan free avec hub_tenant_id', async () => {
    provisionWorkspace.mockResolvedValue({ workspace_id: 'ws1', api_key: 'k', created: true });
    const { provisionNotifuseTenant } = await import('@/utils/tenants/provision');
    await provisionNotifuseTenant('a@b.c', 'u1');
    expect(provisionWorkspace.mock.calls[0][0]).toMatchObject({ hubTenantId: 't-hub' });
    expect(updatePlan).toHaveBeenCalledWith({ tenantId: 'ws1', plan: 'free', hubTenantId: 't-hub' });
  });
  it('espace existant : aucun update-plan (pas de rétrogradation)', async () => {
    provisionWorkspace.mockResolvedValue({ workspace_id: 'ws1', api_key: 'k', created: false });
    const { provisionNotifuseTenant } = await import('@/utils/tenants/provision');
    await provisionNotifuseTenant('a@b.c', 'u1');
    expect(updatePlan).not.toHaveBeenCalled();
  });
});

describe('provisionNotifuseTenant : l\'identifiant d\'espace', () => {
  const provisionner = async (email = 'contact@a.fr') => (await import('@/utils/tenants/provision')).provisionNotifuseTenant(email, 'u1');
  it('tiré du tenant, le même à chaque rejeu, jamais de l\'adresse', async () => {
    provisionWorkspace.mockImplementation(async (x: any) => ({ workspace_id: x.tenantId, api_key: 'k', created: true }));
    await provisionner();
    await provisionner('contact@b.fr');
    const [a, b] = provisionWorkspace.mock.calls.map(([x]) => x.tenantId);
    expect([a, a.includes('contact')]).toEqual([b, false]);
    expect((tenantEcrit.mock.calls[0] as any)[0]).toMatchObject({ where: { id: 't-hub' }, data: { notifuseWorkspaceSlug: a, notifuseApiKey: 'k' } });
  });
  it('un espace déjà noté garde le sien ; un rejeu sans clé n\'efface pas celle qu\'on a', async () => {
    tenantLu.mockResolvedValue({ notifuseWorkspaceSlug: 'contact', metadata: { crm: 1 } });
    provisionWorkspace.mockResolvedValue({ workspace_id: 'contact', api_key: '', created: false });
    await provisionner();
    expect(provisionWorkspace.mock.calls[0][0].tenantId).toBe('contact');
    expect((tenantEcrit.mock.calls[0] as any)[0].data).toEqual({ notifuseWorkspaceSlug: 'contact', notifuseUserEmail: 'contact@a.fr' });
  });
});
