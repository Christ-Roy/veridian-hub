import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const { authenticateAdminMock, createOnboardingInvitationMock, resolveActorMock, writeAuditLogMock } =
  vi.hoisted(() => ({
    authenticateAdminMock: vi.fn(),
    createOnboardingInvitationMock: vi.fn(),
    resolveActorMock: vi.fn(),
    writeAuditLogMock: vi.fn(),
  }));

vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: authenticateAdminMock,
}));

vi.mock('@/lib/admin/audit-log', () => ({
  resolveActor: resolveActorMock,
  writeAuditLog: writeAuditLogMock,
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { __brand: 'prisma-mock' },
}));

vi.mock('@/lib/onboarding/service', () => ({
  createOnboardingInvitation: createOnboardingInvitationMock,
}));

import { POST } from '@/app/api/admin/onboarding/invite/route';

function makeReq(body: unknown) {
  return new Request('https://app.veridian.site/api/admin/onboarding/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-veridian-actor': 'robert' },
    body: JSON.stringify(body),
  }) as never;
}

describe('POST /api/admin/onboarding/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdminMock.mockResolvedValue({
      ok: true,
      sessionEmail: 'robert@veridian.site',
    });
    resolveActorMock.mockReturnValue('admin:robert@veridian.site');
    createOnboardingInvitationMock.mockResolvedValue({
      userId: 'user_1',
      email: 'client@example.com',
      inviteUrl: 'https://app.veridian.site/onboard/token',
      expiresAt: new Date('2026-09-01T12:00:00.000Z'),
      apps: ['hub', 'notifuse'],
      emailSent: false,
    });
    writeAuditLogMock.mockResolvedValue(undefined);
  });

  it('refuse avant toute mutation si authenticateAdmin rejette', async () => {
    authenticateAdminMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });

    const res = await POST(makeReq({ email: 'client@example.com' }));

    expect(res.status).toBe(401);
    expect(createOnboardingInvitationMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('valide strictement les apps autorisées avant de générer un lien', async () => {
    const res = await POST(
      makeReq({
        email: 'client@example.com',
        apps: ['hub', 'unknown-app'],
        sendEmail: false,
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(createOnboardingInvitationMock).not.toHaveBeenCalled();
  });

  it('génère une invitation sans email quand sendEmail=false et écrit un audit', async () => {
    const res = await POST(
      makeReq({
        email: 'client@example.com',
        apps: ['hub', 'notifuse'],
        invitedBy: 'Robert',
        sendEmail: false,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      user_id: 'user_1',
      email: 'client@example.com',
      invite_url: 'https://app.veridian.site/onboard/token',
      expires_at: '2026-09-01T12:00:00.000Z',
      apps: ['hub', 'notifuse'],
      email_sent: false,
    });
    expect(createOnboardingInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ __brand: 'prisma-mock' }),
      {
        email: 'client@example.com',
        apps: ['hub', 'notifuse'],
        actor: 'admin:robert@veridian.site',
        invitedBy: 'Robert',
        sendEmail: false,
      },
    );
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ __brand: 'prisma-mock' }),
      expect.objectContaining({
        action: 'admin.onboarding.invite',
        actor: 'admin:robert@veridian.site',
        targetType: 'user',
        targetId: 'user_1',
        payload: expect.objectContaining({
          email: 'client@example.com',
          apps: ['hub', 'notifuse'],
          email_sent: false,
        }),
      }),
    );
  });

  it('retourne 404 user_not_found sans audit si le user Hub n’existe pas', async () => {
    createOnboardingInvitationMock.mockRejectedValue(
      Object.assign(new Error('User not found'), { code: 'user_not_found' }),
    );

    const res = await POST(makeReq({ email: 'absent@example.com', sendEmail: false }));

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: 'user_not_found',
      message: expect.stringMatching(/Créer le user Hub/),
    });
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });
});
