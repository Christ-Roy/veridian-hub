/**
 * Tests pour GET /api/admin/crm/tenants/[id]/api-key.
 *
 * Couvre :
 *  - 401 si auth denied
 *  - 400 si id manquant
 *  - 404 si tenant introuvable
 *  - 410 si tenant deleted (pas de reveal sur un tenant supprimé)
 *  - 500 si vault throws (clé invalide / payload corrompu)
 *  - 200 happy path : apiKey + audit log "reveal-api-key"
 *  - Audit log écrit MÊME en cas de reveal (forensics critique)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueCrmMock = vi.fn();
const authenticateAdminMock = vi.fn();
const writeAuditLogMock = vi.fn();
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
  twentyApiKeyId: 'apikey-uuid',
  twentyApiKeyEncrypted: 'enc(bearer-real)',
  twentyApiKeyExpiresAt: new Date('2027-05-27T12:00:00Z'),
  status: 'active',
};

beforeEach(() => {
  findUniqueCrmMock.mockReset();
  authenticateAdminMock.mockReset();
  writeAuditLogMock.mockReset();
  decryptSecretMock.mockReset();

  authenticateAdminMock.mockResolvedValue(authOK);
  decryptSecretMock.mockImplementation((c: string) => c.replace(/^enc\(/, '').replace(/\)$/, ''));
});

const makeReq = () =>
  new Request('http://x/api/admin/crm/tenants/tenant-uuid/api-key', { method: 'GET' });

const makeCtx = (id = 'tenant-uuid') => ({ params: Promise.resolve({ id }) });

describe('GET /api/admin/crm/tenants/[id]/api-key', () => {
  it('401 if auth denied', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied401);
    const { GET } = await import('@/app/api/admin/crm/tenants/[id]/api-key/route');
    const res = await GET(makeReq() as never, makeCtx());
    expect(res.status).toBe(401);
    expect(findUniqueCrmMock).not.toHaveBeenCalled();
  });

  it('400 if id missing', async () => {
    const { GET } = await import('@/app/api/admin/crm/tenants/[id]/api-key/route');
    const res = await GET(makeReq() as never, makeCtx(''));
    expect(res.status).toBe(400);
  });

  it('404 if tenant not found', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(null);
    const { GET } = await import('@/app/api/admin/crm/tenants/[id]/api-key/route');
    const res = await GET(makeReq() as never, makeCtx());
    expect(res.status).toBe(404);
    expect(decryptSecretMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('410 if tenant is deleted', async () => {
    findUniqueCrmMock.mockResolvedValueOnce({ ...sampleTenant, status: 'deleted' });
    const { GET } = await import('@/app/api/admin/crm/tenants/[id]/api-key/route');
    const res = await GET(makeReq() as never, makeCtx());
    expect(res.status).toBe(410);
    expect(decryptSecretMock).not.toHaveBeenCalled();
  });

  it('200 happy path : returns apiKey + writes "reveal-api-key" audit log', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(sampleTenant);
    const { GET } = await import('@/app/api/admin/crm/tenants/[id]/api-key/route');
    const res = await GET(makeReq() as never, makeCtx());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKey).toBe('bearer-real');
    expect(body.expiresAt).toBe('2027-05-27T12:00:00.000Z');
    expect(body.workspaceId).toBe('ws-uuid');
    expect(body.workspaceUrl).toBe('https://acme.crm/');

    expect(decryptSecretMock).toHaveBeenCalledWith('enc(bearer-real)');

    // Audit log forensics CRITIQUE
    expect(writeAuditLogMock).toHaveBeenCalledOnce();
    const auditArg = writeAuditLogMock.mock.calls[0][1];
    expect(auditArg.action).toBe('admin.crm.tenant.reveal-api-key');
    expect(auditArg.targetId).toBe('tenant-uuid');
    // Audit ne contient JAMAIS le Bearer
    expect(JSON.stringify(auditArg.payload)).not.toContain('bearer-real');
  });

  it('500 if decryptSecret throws (vault payload corrompu)', async () => {
    findUniqueCrmMock.mockResolvedValueOnce(sampleTenant);
    decryptSecretMock.mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    const { GET } = await import('@/app/api/admin/crm/tenants/[id]/api-key/route');
    const res = await GET(makeReq() as never, makeCtx());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('vault_unavailable');
    // Pas d'audit log si la lecture a échoué (rien n'a été révélé)
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });
});
