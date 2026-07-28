/**
 * Tests pour POST /api/admin/notifuse/magic-link
 *
 * Couvre :
 *  - 401 si pas de session Auth.js
 *  - 400 si body sans tenantId / JSON invalide
 *  - 404 si tenantId format invalide (non-UUID) — pas de Prisma throw
 *  - 404 si tenant introuvable en DB
 *  - 403 si user n'est ni owner ni admin platform
 *  - 409 si tenant pas provisionné (apiKey/userEmail manquants)
 *  - 500 si NOTIFUSE_API_URL / NOTIFUSE_HUB_API_SECRET manquant
 *  - 200 OK pour owner avec downstream fonctionnel
 *  - 200 OK pour admin platform (bypass ownership)
 *  - 502 si NotifuseError downstream
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authMock = vi.fn();
const tenantFindUniqueMock = vi.fn();
const userFindUniqueMock = vi.fn();
const generateMagicLinkMock = vi.fn();
const getHealthMock = vi.fn();
const provisionWorkspaceMock = vi.fn();
const tenantUpdateMock = vi.fn();
const isPlatformAdminMock = vi.fn();

vi.mock('@/auth', () => ({ auth: (...args: unknown[]) => authMock(...args) }));
vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: (...args: unknown[]) => isPlatformAdminMock(...args),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    tenant: { findUnique: tenantFindUniqueMock, update: tenantUpdateMock },
    user: { findUnique: userFindUniqueMock },
  },
}));
// Le resolver (lib/notifuse/resolve-autologin.ts) utilise trois méthodes du
// client : generateMagicLink (chemin nominal) puis getHealth +
// provisionWorkspace (chemin de réparation HMAC).
vi.mock('@/lib/notifuse/client', () => ({
  NotifuseClient: class {
    generateMagicLink(...args: unknown[]) {
      return generateMagicLinkMock(...args);
    }
    getHealth(...args: unknown[]) {
      return getHealthMock(...args);
    }
    provisionWorkspace(...args: unknown[]) {
      return provisionWorkspaceMock(...args);
    }
  },
}));

beforeEach(() => {
  authMock.mockReset();
  tenantFindUniqueMock.mockReset();
  userFindUniqueMock.mockReset();
  generateMagicLinkMock.mockReset();
  getHealthMock.mockReset();
  provisionWorkspaceMock.mockReset();
  tenantUpdateMock.mockReset();
  tenantUpdateMock.mockResolvedValue({});
  isPlatformAdminMock.mockReset();
  isPlatformAdminMock.mockReturnValue(false);
  process.env.NOTIFUSE_API_URL = 'https://notifuse.test.veridian.site';
  process.env.NOTIFUSE_HUB_API_SECRET = 'test-secret-very-strong-32chars-min';
});

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

const makeReq = (body: unknown) =>
  new Request('http://x/api/admin/notifuse/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const sessionOK = (overrides: Record<string, unknown> = {}) => ({
  user: {
    id: 'user-text-id-1',
    email: 'a@x.com',
    ...overrides,
  },
});

describe('POST /api/admin/notifuse/magic-link', () => {
  it('401 si pas de session', async () => {
    authMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
  });

  it('400 si body sans tenantId', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({}) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/tenant/i);
  });

  it('400 si JSON invalide', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq('not json') as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON');
  });

  // 🔥 Régression H-03 : tenantId format non-UUID arrivait jusqu'à Prisma
  // qui throw PrismaClientKnownRequestError (invalid uuid syntax) → 500.
  // Maintenant on retourne 404 (sémantiquement équivalent à not found)
  // SANS appeler Prisma.
  it('404 si tenantId format invalide (non-UUID) — pas de Prisma call', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: 'mega-h-1234-ghost' }) as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Tenant not found');
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
  });

  it('404 si tenantId UUID valide mais introuvable en DB', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(404);
    expect(tenantFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VALID_UUID } }),
    );
  });

  it('403 si user n\'est ni owner ni admin platform', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid-aaa',
      notifuseApiKey: 'k',
      notifuseUserEmail: 'owner@x.com',
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'other-uuid-bbb' });
    isPlatformAdminMock.mockReturnValue(false);

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    expect(generateMagicLinkMock).not.toHaveBeenCalled();
  });

  it('409 si aucun workspace Notifuse rattaché (ni clé, ni slug)', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid',
      notifuseWorkspaceSlug: null,
      notifuseApiKey: null,
      notifuseUserEmail: null,
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('not_linked');
    expect(generateMagicLinkMock).not.toHaveBeenCalled();
  });

  it("200 pour un tenant rattaché par `hub link` (slug seul, aucun credential)", async () => {
    // C'est LE cas de régression du ticket autologin : avant le fix, cette
    // requête répondait 409 et le client tombait sur le login Notifuse.
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid',
      notifuseWorkspaceSlug: 'celinegaetan',
      notifuseApiKey: null,
      notifuseUserEmail: null,
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    getHealthMock.mockResolvedValueOnce({
      magic_link_capable: true,
      owner_attached: true,
      owner_email: 'celine@client.test',
      status: 'active',
    });
    provisionWorkspaceMock.mockResolvedValueOnce({
      created: false,
      api_key: '',
      auto_login_url: 'https://notifuse.test/veridian/auto-login?token=zzz',
    });

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.autoLoginUrl).toContain('/veridian/auto-login');
    expect(body.source).toBe('provision_idempotent');
    // L'email owner découvert est persisté pour le prochain clic.
    expect(tenantUpdateMock).toHaveBeenCalledWith({
      where: { id: VALID_UUID },
      data: { notifuseUserEmail: 'celine@client.test' },
    });
  });

  it('500 si NOTIFUSE_API_URL absent', async () => {
    delete process.env.NOTIFUSE_API_URL;
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid',
      notifuseApiKey: 'k',
      notifuseUserEmail: 'owner@x.com',
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it('200 OK pour owner avec downstream fonctionnel', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid',
      notifuseApiKey: 'api-key-xyz',
      notifuseUserEmail: 'owner@x.com',
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    generateMagicLinkMock.mockResolvedValueOnce({
      magic_link: 'https://notifuse.staging.veridian.site/magic?token=abc',
      auto_login_url: 'https://notifuse.staging.veridian.site/auto?token=abc',
      expires_at: '2026-05-26T00:00:00Z',
    });

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.magicLink).toMatch(/notifuse\.staging\.veridian\.site/);
    expect(body.autoLoginUrl).toMatch(/notifuse\.staging\.veridian\.site/);
    expect(body.expiresAt).toBe('2026-05-26T00:00:00Z');
    expect(generateMagicLinkMock).toHaveBeenCalledWith({
      apiKey: 'api-key-xyz',
      userEmail: 'owner@x.com',
    });
  });

  it('200 OK pour admin platform même si pas owner (bypass ownership)', async () => {
    authMock.mockResolvedValueOnce(sessionOK({ email: 'admin@veridian.site' }));
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'someone-else-uuid',
      notifuseApiKey: 'api-key',
      notifuseUserEmail: 'other@x.com',
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'admin-uuid' });
    isPlatformAdminMock.mockReturnValue(true);
    generateMagicLinkMock.mockResolvedValueOnce({
      magic_link: 'https://notifuse.staging.veridian.site/magic?token=adm',
      auto_login_url: 'https://notifuse.staging.veridian.site/auto?token=adm',
      expires_at: '2026-05-26T00:00:00Z',
    });

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(200);
  });

  it('502 quand les DEUX chemins échouent downstream', async () => {
    const { NotifuseError } = await import('@/lib/notifuse/types');
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid',
      notifuseWorkspaceSlug: 'acme',
      notifuseApiKey: 'k',
      notifuseUserEmail: 'o@x.com',
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    generateMagicLinkMock.mockRejectedValueOnce(
      new NotifuseError('downstream down', 502, null),
    );
    getHealthMock.mockRejectedValueOnce(new NotifuseError('downstream down', 502, null));

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(502);
  });

  it('bascule sur le chemin de réparation si la clé API est morte', async () => {
    const { NotifuseError } = await import('@/lib/notifuse/types');
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce({
      id: VALID_UUID,
      userId: 'owner-uuid',
      notifuseWorkspaceSlug: 'acme',
      notifuseApiKey: 'revoked',
      notifuseUserEmail: 'o@x.com',
    });
    userFindUniqueMock.mockResolvedValueOnce({ supabaseUserId: 'owner-uuid' });
    generateMagicLinkMock.mockRejectedValueOnce(new NotifuseError('unauthorized', 401, null));
    getHealthMock.mockResolvedValueOnce({
      magic_link_capable: true,
      owner_attached: true,
      owner_email: 'o@x.com',
      status: 'active',
    });
    provisionWorkspaceMock.mockResolvedValueOnce({
      created: false,
      api_key: '',
      auto_login_url: 'https://notifuse.test/veridian/auto-login?token=repair',
    });

    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: VALID_UUID }) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe('provision_idempotent');
  });

  it('UUID check accepte UUID majuscule (case-insensitive)', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    tenantFindUniqueMock.mockResolvedValueOnce(null);
    const upperUuid = VALID_UUID.toUpperCase();
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: upperUuid }) as never);
    expect(res.status).toBe(404);
    expect(tenantFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: upperUuid } }),
    );
  });

  it('UUID check rejette les whitespace embedded', async () => {
    authMock.mockResolvedValueOnce(sessionOK());
    const { POST } = await import('@/app/api/admin/notifuse/magic-link/route');
    const res = await POST(makeReq({ tenantId: '1111 2222 3333 4444 555555555555' }) as never);
    expect(res.status).toBe(404);
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
  });
});
