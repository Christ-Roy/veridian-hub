/**
 * Tests pour POST /api/dashboard/crm/regenerate-magic-link.
 *
 * Couvre :
 *   1. 401 si pas de session
 *   2. 404 si user sans CrmTenant
 *   3. 409 si tenant existe mais status != 'active'
 *   4. 200 + magicLinkUrl si tenant actif
 *   5. 502 si la lib Twenty throw
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCrmTenantMock = vi.fn();
const regenerateMagicLinkMock = vi.fn();

vi.mock('@/lib/crm/select-tenant', () => ({
  getCrmTenantByUserId: (...args: any[]) => getCrmTenantMock(...args),
}));

vi.mock('@/lib/crm/client', () => ({
  regenerateMagicLink: (...args: any[]) => regenerateMagicLinkMock(...args),
}));

let mockUser: any = {
  id: 'u-1',
  email: 'r@test.io',
  supabaseUserId: 'uuid-1',
};

vi.mock('@/lib/auth/get-user', () => ({
  getCurrentUser: vi.fn(async () => mockUser),
  userUuid: (u: any) => u.supabaseUserId,
}));

import { POST } from '@/app/api/dashboard/crm/regenerate-magic-link/route';

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'u-1', email: 'r@test.io', supabaseUserId: 'uuid-1' };
});

describe('POST /api/dashboard/crm/regenerate-magic-link', () => {
  it('401 si pas de session', async () => {
    mockUser = null;
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('404 si user sans CrmTenant', async () => {
    getCrmTenantMock.mockResolvedValueOnce(null);
    const res = await POST();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no crm tenant/i);
  });

  it('409 si tenant status=suspended', async () => {
    getCrmTenantMock.mockResolvedValueOnce({
      id: 'ct-1',
      twentyWorkspaceId: 'ws-1',
      status: 'suspended',
      createdAt: new Date(),
    });
    const res = await POST();
    expect(res.status).toBe(409);
  });

  it('200 + magicLinkUrl quand tenant actif', async () => {
    getCrmTenantMock.mockResolvedValueOnce({
      id: 'ct-1',
      twentyWorkspaceId: 'ws-1',
      status: 'active',
      createdAt: new Date(),
    });
    const expiresAt = new Date('2099-01-01T00:00:00Z');
    regenerateMagicLinkMock.mockResolvedValueOnce({
      magicLinkUrl: 'https://crm.example/x?token=abc',
      expiresAt,
    });
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.magicLinkUrl).toBe('https://crm.example/x?token=abc');
    expect(body.expiresAt).toBe(expiresAt.toISOString());
    expect(regenerateMagicLinkMock).toHaveBeenCalledWith('ct-1');
  });

  it('502 si la lib Twenty throw', async () => {
    getCrmTenantMock.mockResolvedValueOnce({
      id: 'ct-1',
      twentyWorkspaceId: 'ws-1',
      status: 'active',
      createdAt: new Date(),
    });
    regenerateMagicLinkMock.mockRejectedValueOnce(new Error('Twenty 503'));
    const res = await POST();
    expect(res.status).toBe(502);
  });

  it('500 si tenant lookup throw', async () => {
    getCrmTenantMock.mockRejectedValueOnce(new Error('DB down'));
    const res = await POST();
    expect(res.status).toBe(500);
  });
});
