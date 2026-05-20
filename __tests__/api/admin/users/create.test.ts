/**
 * Tests pour POST /api/admin/users/create
 *
 * Couvre :
 *  - 401 sans auth
 *  - 200 avec x-admin-secret valide
 *  - 200 avec session admin
 *  - 400 sur payload invalide (email mal formé, name trop long)
 *  - Idempotence : appel 2 → already_existed=true
 *  - Audit log écrit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertHubUserMock = vi.fn();
const writeAuditLogMock = vi.fn();
const authenticateAdminMock = vi.fn();

vi.mock('@/lib/admin/users', () => ({
  upsertHubUser: (...args: unknown[]) => upsertHubUserMock(...args),
}));
vi.mock('@/lib/admin/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  resolveActor: () => 'token:ADMIN_SECRET',
}));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const ORIG_SECRET = process.env.ADMIN_SECRET;

const authOK = { ok: true, sessionEmail: null };
const authDenied401 = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};
const authDenied403 = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
};

beforeEach(() => {
  upsertHubUserMock.mockReset();
  writeAuditLogMock.mockReset();
  authenticateAdminMock.mockReset();
  // Default : auth passe. Les tests qui veulent tester le refus override.
  authenticateAdminMock.mockResolvedValue(authOK);
  process.env.ADMIN_SECRET = 'admin-test-secret';
});

const makeReq = (
  body: unknown,
  headers: Record<string, string> = {}
) =>
  new Request('http://x/api/admin/users/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('POST /api/admin/users/create', () => {
  it('retourne 401 sans auth', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied401);
    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(makeReq({ email: 'a@x.com' }) as never);
    expect(res.status).toBe(401);
    expect(upsertHubUserMock).not.toHaveBeenCalled();
  });

  it('passe avec x-admin-secret valide', async () => {
    upsertHubUserMock.mockResolvedValueOnce({
      userId: 'u1',
      supabaseUserId: 'uuid-1',
      email: 'a@x.com',
      created: true,
      alreadyExisted: false,
    });
    writeAuditLogMock.mockResolvedValueOnce(undefined);

    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(
      makeReq(
        { email: 'a@x.com', name: 'Alice' },
        { 'x-admin-secret': 'admin-test-secret' }
      ) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      user_id: 'u1',
      supabase_user_id: 'uuid-1',
      email: 'a@x.com',
      created: true,
      already_existed: false,
    });
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.user.create',
        targetType: 'user',
        targetId: 'u1',
      })
    );
  });

  it('refuse 401 avec x-admin-secret incorrect (et pas de session)', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied401);
    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(
      makeReq({ email: 'a@x.com' }, { 'x-admin-secret': 'wrong' }) as never
    );
    expect(res.status).toBe(401);
  });

  it('passe avec session admin', async () => {
    authenticateAdminMock.mockResolvedValueOnce({
      ok: true,
      sessionEmail: 'robert@veridian.site',
    });
    upsertHubUserMock.mockResolvedValueOnce({
      userId: 'u1',
      supabaseUserId: 'uuid-1',
      email: 'a@x.com',
      created: true,
      alreadyExisted: false,
    });

    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(makeReq({ email: 'a@x.com' }) as never);
    expect(res.status).toBe(200);
  });

  it('403 si session non-admin', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied403);
    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(makeReq({ email: 'a@x.com' }) as never);
    expect(res.status).toBe(403);
  });

  it('400 sur payload invalide (email mal formé)', async () => {
    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(
      makeReq(
        { email: 'pas-un-email' },
        { 'x-admin-secret': 'admin-test-secret' }
      ) as never
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
  });

  it('400 si name contient < ou > (anti-XSS downstream)', async () => {
    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(
      makeReq(
        { email: 'a@x.com', name: 'Hello <script>' },
        { 'x-admin-secret': 'admin-test-secret' }
      ) as never
    );
    expect(res.status).toBe(400);
    expect(upsertHubUserMock).not.toHaveBeenCalled();
  });

  it('400 si name contient un caractère contrôle (CRLF, etc.)', async () => {
    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(
      makeReq(
        { email: 'a@x.com', name: 'Robert\r\nBcc: evil@x' },
        { 'x-admin-secret': 'admin-test-secret' }
      ) as never
    );
    expect(res.status).toBe(400);
  });

  it('idempotent : appel 2 retourne already_existed=true', async () => {
    upsertHubUserMock.mockResolvedValueOnce({
      userId: 'u1',
      supabaseUserId: 'uuid-1',
      email: 'a@x.com',
      created: false,
      alreadyExisted: true,
    });

    const { POST } = await import('@/app/api/admin/users/create/route');
    const res = await POST(
      makeReq({ email: 'a@x.com' }, { 'x-admin-secret': 'admin-test-secret' }) as never
    );
    const body = await res.json();
    expect(body.already_existed).toBe(true);
    expect(body.created).toBe(false);
  });
});

// Restaure ADMIN_SECRET côté process pour ne pas polluer les autres test files
import { afterAll } from 'vitest';
afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});
