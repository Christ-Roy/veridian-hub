import { describe, it, expect, vi, beforeEach } from 'vitest';

const { activateMock, limiterMock } = vi.hoisted(() => ({
  activateMock: vi.fn(),
  limiterMock: { enforceWithBypass: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { __brand: 'prisma-mock' },
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  extractClientIp: (headers: Headers) => headers.get('x-forwarded-for') ?? 'unknown',
  onboardingConsumeLimiter: limiterMock,
}));

vi.mock('@/lib/onboarding/service', () => ({
  activateOnboarding: activateMock,
}));

import { POST } from '@/app/api/onboarding/[token]/activate/route';

function makeReq(body: unknown, ip = '203.0.113.20') {
  return new Request('https://app.veridian.site/api/onboarding/token/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }) as never;
}

describe('POST /api/onboarding/[token]/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limiterMock.enforceWithBypass.mockReturnValue({ ok: true, remaining: 9 });
    activateMock.mockResolvedValue({
      email: 'client@example.com',
      userId: 'user_1',
      apps: ['hub', 'notifuse'],
      provisioning: { notifuse: { success: true } },
    });
  });

  it('rate-limit avant validation coûteuse et avant bcrypt/provisioning', async () => {
    limiterMock.enforceWithBypass.mockReturnValue({ ok: false, retryAfterSeconds: 60 });

    const res = await POST(makeReq({ password: 'Motdepasse10' }), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(activateMock).not.toHaveBeenCalled();
  });

  it('rejette un mot de passe trop court sans consommer le token', async () => {
    const res = await POST(makeReq({ password: 'court' }), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(activateMock).not.toHaveBeenCalled();
  });

  it('rejette les mots de passe bcrypt au-delà de 72 bytes UTF-8', async () => {
    const res = await POST(makeReq({ password: 'é'.repeat(37) }), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body.issues)).toContain('password_max_72_bytes');
    expect(activateMock).not.toHaveBeenCalled();
  });

  it('active le compte et renvoie la destination dashboard', async () => {
    const res = await POST(makeReq({ password: 'Motdepasse10' }), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(200);
    expect(activateMock).toHaveBeenCalledWith(
      expect.objectContaining({ __brand: 'prisma-mock' }),
      { token: 'raw-token', password: 'Motdepasse10' },
    );
    expect(await res.json()).toEqual({
      ok: true,
      email: 'client@example.com',
      user_id: 'user_1',
      apps: ['hub', 'notifuse'],
      provisioning: { notifuse: { success: true } },
      next: '/dashboard',
    });
  });

  it('mappe expired en 410 et invalid/activated en 400', async () => {
    for (const [code, status] of [
      ['expired', 410],
      ['invalid', 400],
      ['activated', 400],
    ] as const) {
      activateMock.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const res = await POST(makeReq({ password: 'Motdepasse10' }), {
        params: Promise.resolve({ token: `token-${code}` }),
      });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ ok: false, code });
    }
  });
});
