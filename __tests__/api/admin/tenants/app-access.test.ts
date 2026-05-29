/**
 * Tests pour POST /api/admin/tenants/app-access
 *
 * Couvre :
 *  - 401 sans auth
 *  - 400 sur payload Zod invalide (app non gated, enabled manquant, email KO)
 *  - 404 si user Hub inexistant / sans supabaseUserId
 *  - 200 happy path activation + audit log écrit
 *  - 200 happy path désactivation
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// vi.hoisted : les mocks sont créés AVANT le hoisting des vi.mock factories,
// donc référençables dedans sans ReferenceError.
const {
  findUniqueMock,
  setTenantAppEnabledMock,
  writeAuditLogMock,
  authenticateAdminMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  setTenantAppEnabledMock: vi.fn(),
  writeAuditLogMock: vi.fn(),
  authenticateAdminMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock }, tenantApp: {} },
}));
vi.mock('@/lib/tenant-apps', async () => {
  const actual = await vi.importActual<any>('@/lib/tenant-apps');
  return {
    ...actual,
    setTenantAppEnabled: (...args: unknown[]) => setTenantAppEnabledMock(...args),
  };
});
vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  resolveActor: () => 'token:ADMIN_SECRET',
}));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));

import { POST } from '@/app/api/admin/tenants/app-access/route';
import { NextRequest } from 'next/server';

const authOK = { ok: true, sessionEmail: null };
const authDenied = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

function req(body: unknown) {
  return new NextRequest('http://localhost/api/admin/tenants/app-access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ORIG_SECRET = process.env.ADMIN_SECRET;

beforeEach(() => {
  findUniqueMock.mockReset();
  setTenantAppEnabledMock.mockReset();
  writeAuditLogMock.mockReset();
  authenticateAdminMock.mockReset();
  authenticateAdminMock.mockResolvedValue(authOK);
  process.env.ADMIN_SECRET = 'admin-test-secret';
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});

describe('POST /api/admin/tenants/app-access', () => {
  it('401 sans auth', async () => {
    authenticateAdminMock.mockResolvedValue(authDenied);
    const res = await POST(req({ user_email: 'a@x.io', app: 'twenty', enabled: true }));
    expect(res.status).toBe(401);
    expect(setTenantAppEnabledMock).not.toHaveBeenCalled();
  });

  it('400 si app non gated (prospection rejeté par le enum)', async () => {
    const res = await POST(req({ user_email: 'a@x.io', app: 'prospection', enabled: true }));
    expect(res.status).toBe(400);
  });

  it('400 si enabled manquant', async () => {
    const res = await POST(req({ user_email: 'a@x.io', app: 'twenty' }));
    expect(res.status).toBe(400);
  });

  it('400 si email invalide', async () => {
    const res = await POST(req({ user_email: 'pas-un-email', app: 'cms', enabled: true }));
    expect(res.status).toBe(400);
  });

  it('404 si user inexistant', async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await POST(req({ user_email: 'a@x.io', app: 'twenty', enabled: true }));
    expect(res.status).toBe(404);
  });

  it('404 si user sans supabaseUserId (pas de UUID bridge)', async () => {
    findUniqueMock.mockResolvedValue({ id: 'u1', supabaseUserId: null });
    const res = await POST(req({ user_email: 'a@x.io', app: 'twenty', enabled: true }));
    expect(res.status).toBe(404);
  });

  it('200 happy path activation + audit log', async () => {
    findUniqueMock.mockResolvedValue({ id: 'u1', supabaseUserId: 'uuid-1' });
    setTenantAppEnabledMock.mockResolvedValue({ appKey: 'twenty', enabled: true });

    const res = await POST(req({ user_email: 'A@X.io', app: 'twenty', enabled: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      user_email: 'a@x.io', // normalisé lowercase
      user_id: 'uuid-1',
      app: 'twenty',
      enabled: true,
    });
    // le helper a reçu le bon UUID bridge
    expect(setTenantAppEnabledMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userUuid: 'uuid-1', appKey: 'twenty', enabled: true }),
    );
    // audit écrit
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.tenant.app_access', targetId: 'uuid-1' }),
    );
  });

  it('200 happy path désactivation', async () => {
    findUniqueMock.mockResolvedValue({ id: 'u1', supabaseUserId: 'uuid-1' });
    setTenantAppEnabledMock.mockResolvedValue({ appKey: 'analytics', enabled: false });

    const res = await POST(req({ user_email: 'a@x.io', app: 'analytics', enabled: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.app).toBe('analytics');
  });
});
