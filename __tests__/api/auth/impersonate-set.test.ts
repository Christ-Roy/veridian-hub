/**
 * Tests pour POST /api/auth/impersonate-set.
 *
 * Couvre (Mode Nuclear — tier 🔴 HAUT AUTH) :
 *  - refus non-admin (401/403 via authenticateAdmin)
 *  - refus d'une session déjà impersonée (anti ré-impersonation)
 *  - body invalide (email manquant / malformé)
 *  - user cible introuvable (404)
 *  - succès admin : token généré + callback_url + audit log
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const authenticateAdminMock = vi.fn();
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: authenticateAdminMock,
}));

const authMock = vi.fn(async () => null);
vi.mock('@/auth', () => ({ auth: authMock }));

const userFindUnique = vi.fn();
const verificationTokenCreate = vi.fn(async () => ({}));
const auditLogCreate = vi.fn(async () => ({}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    verificationToken: { create: verificationTokenCreate },
    auditLog: { create: auditLogCreate },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  authMock.mockResolvedValue(null);
  // Par défaut : admin autorisé via session.
  authenticateAdminMock.mockResolvedValue({ ok: true, sessionEmail: 'robert@veridian.site' });
  userFindUnique.mockResolvedValue({ id: 'user-1', email: 'target@veridian.site' });
});

function makeReq(body: unknown) {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as never;
}

describe('POST /api/auth/impersonate-set', () => {
  it('refuse si authenticateAdmin échoue (401)', async () => {
    authenticateAdminMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    const res = await POST(makeReq({ email: 'target@veridian.site' }));
    expect(res.status).toBe(401);
  });

  it('refuse une session courante déjà impersonée (403)', async () => {
    authMock.mockResolvedValue({ user: { impersonated: true } } as never);
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    const res = await POST(makeReq({ email: 'target@veridian.site' }));
    expect(res.status).toBe(403);
    expect(verificationTokenCreate).not.toHaveBeenCalled();
  });

  it('rejette un body sans email (400)', async () => {
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('rejette un email malformé (400)', async () => {
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    const res = await POST(makeReq({ email: 'pas-un-email' }));
    expect(res.status).toBe(400);
  });

  it('404 si user cible introuvable', async () => {
    userFindUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    const res = await POST(makeReq({ email: 'ghost@veridian.site' }));
    expect(res.status).toBe(404);
    expect(verificationTokenCreate).not.toHaveBeenCalled();
  });

  it('succès : génère le token + callback_url + audit log', async () => {
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    const res = await POST(makeReq({ email: 'target@veridian.site' }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.target_user_id).toBe('user-1');
    expect(body.callback_url).toContain('/api/auth/impersonate-callback?token=');
    expect(body.expires_at).toBeTruthy();

    // Token stocké hashé, identifier préfixé.
    expect(verificationTokenCreate).toHaveBeenCalledTimes(1);
    const tokenArg = verificationTokenCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(tokenArg.data.identifier).toBe('impersonate:user-1');
    expect(tokenArg.data.token).toMatch(/^[a-f0-9]{64}$/);

    // Audit log start.
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const auditArg = auditLogCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(auditArg.data.action).toBe('admin.impersonate.start');
    expect(auditArg.data.actor).toBe('admin:robert@veridian.site');
    expect(auditArg.data.targetId).toBe('user-1');
  });

  it('actor = token:ADMIN_SECRET si auth via secret (pas de session)', async () => {
    authenticateAdminMock.mockResolvedValue({ ok: true, sessionEmail: null });
    const { POST } = await import('@/app/api/auth/impersonate-set/route');
    await POST(makeReq({ email: 'target@veridian.site' }));
    const auditArg = auditLogCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(auditArg.data.actor).toBe('token:ADMIN_SECRET');
  });
});
