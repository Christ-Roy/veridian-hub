/**
 * POST /api/admin/notifuse/magic-link : ouvre Mail par le rebond signé (`lienApp('notifuse')`),
 * jamais par un lien Notifuse fabriqué par le Hub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDenyUnlessEmailProven = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/lib/auth/email-proof', () => ({
  denyUnlessEmailProven: mockDenyUnlessEmailProven,
  isEmailProvenForSession: vi.fn(async () => true),
  issueEmailProof: vi.fn(async () => true),
}));

const authMock = vi.fn();
const tenantFindUniqueMock = vi.fn();
const userFindUniqueMock = vi.fn();
const isPlatformAdminMock = vi.fn();

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));
vi.mock('@/lib/admin/session-admin', () => ({
  sessionAdmin: async (...args: unknown[]) => ({ ok: await isPlatformAdminMock(...args) }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: { findUnique: tenantFindUniqueMock },
    user: { findUnique: userFindUniqueMock },
  },
}));

beforeEach(() => {
  authMock.mockReset();
  tenantFindUniqueMock.mockReset();
  userFindUniqueMock.mockReset();
  mockDenyUnlessEmailProven.mockReset();
  mockDenyUnlessEmailProven.mockResolvedValue(null);
  isPlatformAdminMock.mockReset();
  isPlatformAdminMock.mockResolvedValue(false);
  process.env.NOTIFUSE_API_URL = 'https://notifuse.test.veridian.site';
});

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

const makeReq = (body: unknown) =>
  new Request('http://x/api/admin/notifuse/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const sessionOK = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'user-text-id-1', email: 'a@x.com', ...overrides },
});

const appeler = async (body: unknown) => {
  const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
  return POST(makeReq(body) as never);
};

describe('POST /api/admin/notifuse/magic-link', () => {
  it('401 si pas de session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(401);
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
  });

  it('refuse une adresse non prouvée', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    mockDenyUnlessEmailProven.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'email_not_proven' }), { status: 403 }),
    );
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(403);
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
  });

  it('400 si body sans tenantId', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const res = await appeler({});
    expect(res.status).toBe(400);
  });

  it('400 si JSON invalide', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const res = await appeler('not json');
    expect(res.status).toBe(400);
  });

  it('404 si tenantId non UUID, sans appel Prisma', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const res = await appeler({ tenantId: 'mega-h-1234-ghost' });
    expect(res.status).toBe(404);
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
  });

  it('404 si le tenant est introuvable', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce(null);
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(404);
  });

  it("403 si ni propriétaire ni admin plateforme", async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({ id: VALID_UUID, userId: 'owner-uuid-aaa', notifuseWorkspaceSlug: 'acme' });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'other-uuid-bbb' });
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(403);
  });

  it('409 si aucun workspace Notifuse rattaché', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({ id: VALID_UUID, userId: 'owner-uuid', notifuseWorkspaceSlug: null });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_linked');
  });

  it('500 si NOTIFUSE_API_URL absent', async () => {
    delete process.env.NOTIFUSE_API_URL;
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({ id: VALID_UUID, userId: 'owner-uuid', notifuseWorkspaceSlug: 'acme' });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(500);
  });

  it("200 : le propriétaire reçoit le rebond de Mail, rien d'autre", async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({ id: VALID_UUID, userId: 'owner-uuid', notifuseWorkspaceSlug: 'acme' });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `/login?next=${encodeURIComponent('https://notifuse.test.veridian.site/console/')}`,
    });
  });

  it("200 pour un admin plateforme qui n'est pas propriétaire", async () => {
    authMock.mockResolvedValueOnce(sessionOK({ email: 'admin@veridian.site' }));
    tenantFindUniqueMock.mockResolvedValueOnce({ id: VALID_UUID, userId: 'someone-else', notifuseWorkspaceSlug: 'acme' });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'admin-uuid' });
    isPlatformAdminMock.mockResolvedValue(true);
    const res = await appeler({ tenantId: VALID_UUID });
    expect(res.status).toBe(200);
  });
});
