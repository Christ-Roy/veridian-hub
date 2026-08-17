import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lookupMock, limiterMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  limiterMock: { enforceWithBypass: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { __brand: 'prisma-mock' },
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  extractClientIp: (headers: Headers) => headers.get('x-forwarded-for') ?? 'unknown',
  onboardingVerifyLimiter: limiterMock,
}));

vi.mock('@/lib/onboarding/service', () => ({
  getOnboardingInviteByToken: lookupMock,
}));

import { GET } from '@/app/api/onboarding/[token]/route';

function makeReq(ip = '203.0.113.10') {
  return new Request('https://app.veridian.site/api/onboarding/token', {
    headers: { 'x-forwarded-for': ip },
  }) as never;
}

describe('GET /api/onboarding/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limiterMock.enforceWithBypass.mockReturnValue({ ok: true, remaining: 29 });
    lookupMock.mockResolvedValue({
      ok: true,
      invite: {
        email: 'client@example.com',
        workspaceName: 'Atelier Robert',
        invitedBy: 'Robert',
        apps: [{ id: 'hub', label: 'Hub', suffix: '.hub', tagline: 'Cockpit' }],
        expiresAt: '2026-09-01T12:00:00.000Z',
      },
    });
  });

  it('rate-limit par IP avant lookup token', async () => {
    limiterMock.enforceWithBypass.mockReturnValue({ ok: false, retryAfterSeconds: 42 });

    const res = await GET(makeReq('198.51.100.1'), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('retourne l’invitation publique sans exposer userId ni token hashé', async () => {
    const res = await GET(makeReq(), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(200);
    expect(lookupMock).toHaveBeenCalledWith(expect.objectContaining({ __brand: 'prisma-mock' }), 'raw-token');
    expect(await res.json()).toEqual({
      ok: true,
      invite: expect.objectContaining({
        email: 'client@example.com',
        workspaceName: 'Atelier Robert',
      }),
    });
  });

  it('mappe un token expiré en 410 Gone pour déclencher l’écran lien expiré', async () => {
    lookupMock.mockResolvedValue({ ok: false, code: 'expired' });

    const res = await GET(makeReq(), {
      params: Promise.resolve({ token: 'expired-token' }),
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ ok: false, code: 'expired' });
  });

  it('mappe les tokens invalides ou déjà activés en 404 public', async () => {
    for (const code of ['invalid', 'activated'] as const) {
      lookupMock.mockResolvedValue({ ok: false, code });
      const res = await GET(makeReq(), {
        params: Promise.resolve({ token: `token-${code}` }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, code });
    }
  });
});
