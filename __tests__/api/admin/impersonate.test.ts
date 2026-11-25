/**
 * Tests pour POST /api/admin/impersonate.
 *
 * Depuis le bouclage LOT D (2026-05-22) : la route ne crée plus de row
 * `Session` (inutile en stratégie JWT) — elle génère un token impersonate
 * via createImpersonationToken (stocké dans verification_tokens) et écrit
 * un audit log `admin.impersonate.start`.
 *
 * Depuis LOT 2-bis (2026-05-22) : l'auth de la route passe par le helper
 * durci `authenticateAdmin` (timing-safe + rate-limit + anti-ré-
 * impersonation) — plus de `requireAdmin` inline. On mocke `authenticateAdmin`
 * pour isoler la route de la mécanique du helper (testée séparément dans
 * __tests__/lib/admin/authenticate.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { NextResponse } from 'next/server';

const authenticateAdminMock = vi.fn();
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: authenticateAdminMock,
}));

const verificationTokenCreate = vi.fn(async () => ({}));
const auditLogCreate = vi.fn(async () => ({ id: 'emprunt-1' }));
const ficheClient = vi.fn(async () => ({
  hubUserId: 'uuid-1', email: 'a@test.io', nom: null, adresseProuvee: true, organisations: [{ id: 't1', nom: 'T', role: 'proprietaire', suspendue: false }],
  apps: [
    { app: 'hub', libelle: 'Hub', etat: 'ouverte', entrable: true, detail: '', espaces: [] },
    { app: 'prospection', libelle: 'Prospection', etat: 'ouverte', entrable: true, detail: '', espaces: [] },
    { app: 'notifuse', libelle: 'Mail', etat: 'inconnu', entrable: false, detail: 'L\'app ne connaît pas ce compte.', espaces: [] },
  ],
}));
vi.mock('@/lib/emprunt/entrees', () => ({ ficheClient }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'auth-1',
        supabaseUserId: 'uuid-1',
        email: 'a@test.io',
      })),
    },
    tenant: {
      findFirst: vi.fn(async () => ({
        id: 't1',
        notifuseWorkspaceSlug: 'ws',
        prospectionPlan: 'freemium',
        prospectionProvisionedAt: new Date(),
      })),
      update: vi.fn(async () => ({})),
    },
    verificationToken: { create: verificationTokenCreate },
    auditLog: { create: auditLogCreate },
  },
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_PROSPECTION_URL = 'https://prospection.test';
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site';
  // Par défaut : admin autorisé via session.
  authenticateAdminMock.mockResolvedValue({ ok: true, sessionEmail: 'robert@veridian.site' });
  globalThis.fetch = vi.fn(async () => new Response(
    JSON.stringify({ login_url: 'https://prospection/api/auth/token?t=xyz' }),
    { status: 200 },
  )) as never;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function makeReq(body: unknown) {
  return {
    json: async () => body,
    headers: { get: () => null },
    url: 'https://app.veridian.site/api/admin/impersonate',
  } as never;
}

describe('POST /api/admin/impersonate', () => {
  it('refuse si authenticateAdmin rejette — non authentifié (401)', async () => {
    authenticateAdminMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(401);
    expect(verificationTokenCreate).not.toHaveBeenCalled();
  });

  it('refuse si authenticateAdmin rejette — non-admin (403)', async () => {
    authenticateAdminMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(403);
    expect(verificationTokenCreate).not.toHaveBeenCalled();
  });

  it('refuse si authenticateAdmin rejette — session impersonée (403, anti-ré-impersonation)', async () => {
    // authenticateAdmin embarque le check isImpersonatedSession : une session
    // impersonée renvoie un 403 "Impersonated session has no admin access."
    authenticateAdminMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'forbidden', message: 'Impersonated session has no admin access.' },
        { status: 403 },
      ),
    });
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toMatch(/impersonated/i);
    expect(verificationTokenCreate).not.toHaveBeenCalled();
  });

  it('refuse si authenticateAdmin rejette — rate-limited (429)', async () => {
    authenticateAdminMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
    });
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const res = await POST(makeReq({ email: 'a@test.io' }));
    expect(res.status).toBe(429);
  });

  it('un lien par app qui ouvre, vers l\'app ; `null` et la raison pour celle qui n\'ouvrirait pas', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    const c = await (await POST(makeReq({ email: 'a@test.io', raison: ' un  appel ' }))).json();
    expect(c.links.hub).toMatch(/^https:\/\/app\.veridian\.site\/api\/auth\/impersonate-callback\?token=[a-f0-9]{64}$/);
    expect(c.links.prospection).toBe(`${c.links.hub}&vers=prospection`);
    expect(c.links.notifuse).toBeNull();
    expect(c.apps.find((x: { app: string }) => x.app === 'notifuse')).toMatchObject({ entrable: false, detail: 'L\'app ne connaît pas ce compte.' });
    expect((auditLogCreate.mock.calls[0] as unknown as [{ data: { payload: unknown } }])[0].data.payload).toMatchObject({ raison: 'un appel', par: 'cle:ADMIN_SECRET', via: 'lien' });
  });

  it('le journal ne s\'écrit pas : aucun lien', async () => {
    auditLogCreate.mockRejectedValueOnce(new Error('base en panne'));
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await expect(POST(makeReq({ email: 'a@test.io' }))).rejects.toThrow('base en panne');
    expect(verificationTokenCreate).not.toHaveBeenCalled();
  });

  it('génère un token impersonate (verification_tokens, pas Session)', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await POST(makeReq({ email: 'a@test.io' }));
    expect(verificationTokenCreate).toHaveBeenCalledTimes(1);
    const arg = verificationTokenCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.identifier).toBe('impersonate:auth-1:emprunt-1');
    expect(arg.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('écrit un audit log admin.impersonate.start avec l\'actor session', async () => {
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await POST(makeReq({ email: 'a@test.io' }));
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const arg = auditLogCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('admin.impersonate.start');
    expect(arg.data.actor).toBe('admin:robert@veridian.site');
    expect(arg.data.targetId).toBe('auth-1');
    expect(arg.data.targetType).toBe('user');
  });

  it('actor = token:ADMIN_SECRET si auth via secret (sessionEmail null)', async () => {
    authenticateAdminMock.mockResolvedValue({ ok: true, sessionEmail: null });
    const { POST } = await import('@/app/api/admin/impersonate/route');
    await POST(makeReq({ email: 'a@test.io' }));
    const arg = auditLogCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.actor).toBe('token:ADMIN_SECRET');
  });
});
