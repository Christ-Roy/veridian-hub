/**
 * Tests pour POST /api/admin/tenants/link-app
 *
 * Couvre :
 *  - 401 sans auth
 *  - 400 sur payload Zod invalide (app inconnu, slug vide, fallback_url mal formé)
 *  - 404 si user Hub inexistant
 *  - 404 si user sans supabaseUserId
 *  - 200 happy path + audit log écrit
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const findUniqueMock = vi.fn();
const linkAppMock = vi.fn();
const writeAuditLogMock = vi.fn();
const authenticateAdminMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: findUniqueMock }, tenant: {} },
}));
vi.mock('@/lib/admin/link-app', () => ({
  linkApp: (...args: unknown[]) => linkAppMock(...args),
}));
vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  resolveActor: () => 'token:ADMIN_SECRET',
}));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));

const ORIG_SECRET = process.env.ADMIN_SECRET;

const authOK = { ok: true, sessionEmail: null };
const authDenied401 = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

beforeEach(() => {
  findUniqueMock.mockReset();
  linkAppMock.mockReset();
  writeAuditLogMock.mockReset();
  authenticateAdminMock.mockReset();
  // Default : auth passe. Tests qui veulent tester le refus override.
  authenticateAdminMock.mockResolvedValue(authOK);
  process.env.ADMIN_SECRET = 'admin-test-secret';
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});

const validPayload = {
  user_email: 'a@x.com',
  app: 'cms',
  external_tenant_id: '1',
  external_tenant_slug: 'avse',
  tenant_name: 'AVSE Monétique',
  plan: 'complimentary',
};

const makeReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/admin/tenants/link-app', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const auth = { 'x-admin-secret': 'admin-test-secret' };

describe('POST /api/admin/tenants/link-app', () => {
  it('401 sans auth', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied401);
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(makeReq(validPayload) as never);
    expect(res.status).toBe(401);
  });

  it('400 si app invalide', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(makeReq({ ...validPayload, app: 'twitter' }, auth) as never);
    expect(res.status).toBe(400);
    expect(linkAppMock).not.toHaveBeenCalled();
  });

  it('400 si tenant_name vide', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(makeReq({ ...validPayload, tenant_name: '' }, auth) as never);
    expect(res.status).toBe(400);
  });

  it('400 si fallback_url utilise javascript: scheme (anti-XSS)', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(
      makeReq(
        { ...validPayload, fallback_url: 'javascript:alert(1)' },
        auth
      ) as never
    );
    expect(res.status).toBe(400);
    expect(linkAppMock).not.toHaveBeenCalled();
  });

  it('400 si fallback_url utilise data: scheme (anti-XSS)', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(
      makeReq(
        { ...validPayload, fallback_url: 'data:text/html,<script>alert(1)</script>' },
        auth
      ) as never
    );
    expect(res.status).toBe(400);
  });

  it('400 si external_tenant_slug contient < > / etc (anti-XSS/path traversal)', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const tests = [
      '<script>alert(1)</script>',
      '../etc/passwd',
      'avse/admin',
      'AVSE', // uppercase rejeté (DNS unsafe)
      '-avse', // ne peut pas commencer par hyphen
    ];
    for (const slug of tests) {
      const res = await POST(
        makeReq({ ...validPayload, external_tenant_slug: slug }, auth) as never
      );
      expect(res.status).toBe(400);
    }
  });

  it('400 si external_tenant_id contient des caractères non-safe', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(
      makeReq({ ...validPayload, external_tenant_id: '1; DROP TABLE--' }, auth) as never
    );
    expect(res.status).toBe(400);
  });

  it('400 si tenant_name contient < ou > (anti-XSS downstream)', async () => {
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(
      makeReq(
        { ...validPayload, tenant_name: 'Hello <img src=x>' },
        auth
      ) as never
    );
    expect(res.status).toBe(400);
  });

  it('200 si fallback_url est un https valide (happy path préservé)', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'u1', supabaseUserId: 'uuid-1' });
    linkAppMock.mockResolvedValueOnce({
      tenantId: 't1',
      userUuid: 'uuid-1',
      app: 'cms',
      metadataPath: 'tenants.metadata.cms',
      created: true,
    });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(
      makeReq(
        { ...validPayload, fallback_url: 'https://cms.veridian.site/admin' },
        auth
      ) as never
    );
    expect(res.status).toBe(200);
  });

  it("404 si user n'existe pas", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(makeReq(validPayload, auth) as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('user_not_found');
  });

  it('404 si user sans supabaseUserId', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'u1', supabaseUserId: null });
    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(makeReq(validPayload, auth) as never);
    expect(res.status).toBe(404);
  });

  it('200 happy path + audit log écrit', async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 'u1', supabaseUserId: 'uuid-1' });
    linkAppMock.mockResolvedValueOnce({
      tenantId: 't1',
      userUuid: 'uuid-1',
      app: 'cms',
      metadataPath: 'tenants.metadata.cms',
      created: true,
    });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const { POST } = await import('@/app/api/admin/tenants/link-app/route');
    const res = await POST(makeReq(validPayload, auth) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      tenant_id: 't1',
      user_id: 'uuid-1',
      app: 'cms',
      metadata_path: 'tenants.metadata.cms',
      created: true,
    });
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.tenant.link', targetType: 'app_link' })
    );
  });
});
