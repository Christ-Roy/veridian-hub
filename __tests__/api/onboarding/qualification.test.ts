import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, saveMock, getMock, limiterMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  saveMock: vi.fn(),
  getMock: vi.fn(),
  limiterMock: { enforceWithBypass: vi.fn() },
}));

vi.mock('@/auth', () => ({
  auth: authMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { __brand: 'prisma-mock' },
}));

vi.mock('@/lib/auth/rate-limit', () => ({
  extractClientIp: (headers: Headers) => headers.get('x-forwarded-for') ?? 'unknown',
  onboardingQualificationLimiter: limiterMock,
}));

vi.mock('@/lib/onboarding/service', () => ({
  getUserOnboardingRecord: getMock,
  saveOnboardingQualification: saveMock,
}));

import { GET, POST } from '@/app/api/onboarding/qualification/route';

function makeReq(body?: unknown, ip = '203.0.113.30') {
  return new Request('https://app.veridian.site/api/onboarding/qualification', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
}

describe('GET /api/onboarding/qualification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: 'user_1', email: 'client@example.com' } });
    limiterMock.enforceWithBypass.mockReturnValue({ ok: true, remaining: 59 });
    getMock.mockResolvedValue({
      userId: 'user_1',
      activatedAt: '2026-08-17T12:00:00.000Z',
      metadata: { qualification: { siteActuel: 'oui' } },
    });
  });

  it('refuse sans session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('rate-limit par userId:IP avant lecture Prisma', async () => {
    limiterMock.enforceWithBypass.mockReturnValue({ ok: false, retryAfterSeconds: 12 });

    const res = await GET(makeReq(undefined, '198.51.100.30'));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect(limiterMock.enforceWithBypass).toHaveBeenCalledWith(
      'user_1:198.51.100.30',
      expect.any(Headers),
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it('retourne la progression onboarding sessionnée', async () => {
    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    expect(getMock).toHaveBeenCalledWith(expect.objectContaining({ __brand: 'prisma-mock' }), 'user_1');
    expect(await res.json()).toEqual({
      ok: true,
      onboarding: expect.objectContaining({ userId: 'user_1' }),
    });
  });
});

describe('POST /api/onboarding/qualification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: 'user_1', email: 'client@example.com' } });
    limiterMock.enforceWithBypass.mockReturnValue({ ok: true, remaining: 59 });
    saveMock.mockResolvedValue({
      userId: 'user_1',
      completedAt: '2026-08-17T12:00:00.000Z',
      metadata: { qualification: { siteActuel: 'non' } },
    });
  });

  it('refuse sans session', async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(makeReq({ qualification: { siteActuel: 'non' } }));

    expect(res.status).toBe(401);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('rejette les champs inconnus pour empêcher le JSON libre dans metadata', async () => {
    const res = await POST(
      makeReq({
        qualification: { siteActuel: 'non', secret: 'should-not-persist' },
        etapeCourante: 'recapitulatif',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('sauvegarde une qualification valide avec étape et completed', async () => {
    const res = await POST(
      makeReq({
        qualification: {
          siteActuel: 'oui',
          intentionSiteExistant: 'refonte',
          emailing: 'liste-existante',
          prospection: 'explorer',
          echeance: 'trimestre',
        },
        etapeCourante: 'recapitulatif',
        completed: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ __brand: 'prisma-mock' }), {
      userId: 'user_1',
      qualification: {
        siteActuel: 'oui',
        intentionSiteExistant: 'refonte',
        emailing: 'liste-existante',
        prospection: 'explorer',
        echeance: 'trimestre',
      },
      etapeCourante: 'recapitulatif',
      completed: true,
    });
    expect(await res.json()).toEqual({
      ok: true,
      onboarding: expect.objectContaining({ userId: 'user_1' }),
    });
  });
});
