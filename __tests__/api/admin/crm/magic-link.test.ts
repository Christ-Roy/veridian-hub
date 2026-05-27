/**
 * Tests pour POST /api/admin/crm/tenants/[id]/magic-link.
 *
 * Couvre :
 *  - 401 si auth denied
 *  - 400 si id manquant
 *  - 404 si tenant introuvable
 *  - 410 si tenant deleted
 *  - 502 si CrmClientError remonte (CRM down ou password rejeté)
 *  - 500 si vault indisponible
 *  - 200 happy path : magicLinkUrl + expiresAt + audit log
 *  - Audit log ne contient PAS le password ni le Bearer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { CrmClientError } from '@/lib/crm/types';

const findUniqueCrmMock = vi.fn();
const authenticateAdminMock = vi.fn();
const writeAuditLogMock = vi.fn();
const regenerateMagicLinkMock = vi.fn();
const decryptSecretMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { crmTenant: { findUnique: findUniqueCrmMock } },
}));

vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));

vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  resolveActor: () => 'token:ADMIN_SECRET',
}));

vi.mock('@/lib/crm/client', () => ({
  createCrmClientFromEnv: () => ({
    regenerateMagicLink: (...args: unknown[]) => regenerateMagicLinkMock(...args),
  }),
}));

vi.mock('@/lib/crm/vault', () => ({
  decryptSecret: (...args: unknown[]) => decryptSecretMock(...args),
}));

const authOK = { ok: true, sessionEmail: null };
const authDenied401 = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

const sampleTenant = {
  id: 'tenant-uuid',
  email: 'client@example.com',
  twentyWorkspaceId: 'ws-uuid',
  twentyWorkspaceUrl: 'https://acme.crm/',
  twentyPasswordEncrypted: 'enc(stored-password)',
  status: 'active',
};

beforeEach(() => {
  findUniqueCrmMock.mockReset();
  authenticateAdminMock.mockReset();
  writeAuditLogMock.mockReset();
  regenerateMagicLinkMock.mockReset();
  decryptSecretMock.mockReset();

  authenticateAdminMock.mockResolvedValue(authOK);
  decryptSecretMock.mockImplementation((c: string) => c.replace(/^enc\(/, '').replace(/\)$/, ''));
});

const makeReq = () =>
  new Request('http://x/api/admin/crm/tenants/tenant-uuid/magic-link', { method: 'POST' });

const makeCtx = (id = 'tenant-uuid') => ({ params: Promise.resolve({ id }) });

describe('POST /api/admin/crm/tenants/[id]/magic-link', () => {
  it('401 if auth denied', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied401);
    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx());
    expect(res.status).toBe(401);
    expect(findUniqueCrmMock).not.toHaveBeenCalled();
  });

  it('400 if id missing', async () => {
    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx(''));
    expect(res.status).toBe(400);
  });

  it('404 if tenant not found', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx());
    expect(res.status).toBe(404);
  });

  it('410 if tenant is deleted', async () => {
    findUniqueCrmMock.mockResolvedValueOnce({ ...sampleTenant, status: 'deleted' });
    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx());
    expect(res.status).toBe(410);
    expect(regenerateMagicLinkMock).not.toHaveBeenCalled();
  });

  it('200 happy path : returns magicLinkUrl + audit log', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(sampleTenant);
    regenerateMagicLinkMock.mockResolvedValueOnce({
      magicLinkUrl: 'https://acme.crm/verify?loginToken=regen',
      expiresAt: new Date('2026-05-27T13:00:00Z'),
    });

    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.magicLinkUrl).toBe('https://acme.crm/verify?loginToken=regen');
    expect(body.expiresAt).toBe('2026-05-27T13:00:00.000Z');

    expect(decryptSecretMock).toHaveBeenCalledWith('enc(stored-password)');
    expect(regenerateMagicLinkMock).toHaveBeenCalledWith({
      email: 'client@example.com',
      passwordDecrypted: 'stored-password',
      workspaceUrl: 'https://acme.crm/',
    });

    expect(writeAuditLogMock).toHaveBeenCalledOnce();
    const auditArg = writeAuditLogMock.mock.calls[0][1];
    expect(auditArg.action).toBe('admin.crm.tenant.regenerate-magic-link');
    expect(auditArg.targetId).toBe('tenant-uuid');
    // Audit ne contient JAMAIS le password
    expect(JSON.stringify(auditArg.payload)).not.toContain('stored-password');
  });

  it('502 if CrmClientError remonte', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(sampleTenant);
    regenerateMagicLinkMock.mockRejectedValueOnce(
      new CrmClientError('upstream timeout', { step: 'getLoginTokenFromCredentials' }),
    );
    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('crm_upstream_error');
    expect(body.step).toBe('getLoginTokenFromCredentials');
  });

  it('500 if vault throws (decryptSecret fails)', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(sampleTenant);
    decryptSecretMock.mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    const { POST } = await import('@/app/api/admin/crm/tenants/[id]/magic-link/route');
    const res = await POST(makeReq() as never, makeCtx());
    expect(res.status).toBe(500);
    expect(regenerateMagicLinkMock).not.toHaveBeenCalled();
  });
});
