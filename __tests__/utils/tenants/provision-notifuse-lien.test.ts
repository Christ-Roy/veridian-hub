/**
 * Un espace Notifuse neuf est relié au tenant Hub (tenant_id du JWT MCP) : Notifuse ne retient ce
 * lien qu'à l'update-plan. Jamais pour un espace existant (l'update-plan free y rétrograderait).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provisionWorkspace = vi.fn();
const updatePlan = vi.fn(async () => undefined);
vi.mock('@/lib/notifuse/client', () => ({ NotifuseClient: class { provisionWorkspace = provisionWorkspace; updatePlan = updatePlan; } }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(async () => ({ id: 't-hub', metadata: {} })),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 't-hub' })),
      update: vi.fn(async () => ({ id: 't-hub' })),
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
