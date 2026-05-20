/**
 * Tests pour DELETE /api/admin/tenants/unlink-app
 *
 * Couvre :
 *  - 401 sans auth
 *  - 400 payload invalide
 *  - 404 user inexistant
 *  - 404 tenant inexistant
 *  - 200 + audit
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const findUniqueMock = vi.fn();
const unlinkAppMock = vi.fn();
const writeAuditLogMock = vi.fn();
const authMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock }, tenant: {} },
}));
vi.mock('@/lib/admin/link-app', () => ({
  unlinkApp: (...args: unknown[]) => unlinkAppMock(...args),
}));
vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  resolveActor: () => 'token:ADMIN_SECRET',
}));
vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));
vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: () => false,
}));

const ORIG_SECRET = process.env.ADMIN_SECRET;

beforeEach(() => {
  findUniqueMock.mockReset();
  unlinkAppMock.mockReset();
  writeAuditLogMock.mockReset();
  authMock.mockReset();
  process.env.ADMIN_SECRET = 'admin-test-secret';
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});

const validPayload = { user_email: 'a@x.com', app: 'cms' };
const auth = { 'x-admin-secret': 'admin-test-secret' };

const makeReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/admin/tenants/unlink-app', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('DELETE /api/admin/tenants/unlink-app', () => {
  it('401 sans auth', async () => {
    authMock.mockResolvedValueOnce(null);
    const { DELETE } = await import('@/app/api/admin/tenants/unlink-app/route');
    const res = await DELETE(makeReq(validPayload) as never);
    expect(res.status).toBe(401);
  });

  it('400 si app invalide', async () => {
    const { DELETE } = await import('@/app/api/admin/tenants/unlink-app/route');
    const res = await DELETE(
      makeReq({ ...validPayload, app: 'twitter' }, auth) as never
    );
    expect(res.status).toBe(400);
  });

  it("404 si user n'existe pas", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { DELETE } = await import('@/app/api/admin/tenants/unlink-app/route');
    const res = await DELETE(makeReq(validPayload, auth) as never);
    expect(res.status).toBe(404);
  });

  it('404 si pas de Tenant pour ce user', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'u1', supabaseUserId: 'uuid-1' });
    unlinkAppMock.mockResolvedValueOnce({ tenantId: '', unlinked: false });
    const { DELETE } = await import('@/app/api/admin/tenants/unlink-app/route');
    const res = await DELETE(makeReq(validPayload, auth) as never);
    expect(res.status).toBe(404);
  });

  it('200 + audit happy path', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'u1', supabaseUserId: 'uuid-1' });
    unlinkAppMock.mockResolvedValueOnce({ tenantId: 't1', unlinked: true });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const { DELETE } = await import('@/app/api/admin/tenants/unlink-app/route');
    const res = await DELETE(makeReq(validPayload, auth) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ tenant_id: 't1', app: 'cms', unlinked: true });
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.tenant.unlink' })
    );
  });
});
