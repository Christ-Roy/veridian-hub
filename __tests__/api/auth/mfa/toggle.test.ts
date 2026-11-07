/** Un compte sans mot de passe (Google seul) ne peut pas activer le MFA par code email. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirst, update } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(async () => ({})),
}));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/lib/auth/recent-auth', () => ({
  denyUnlessRecentAuth: async () => null,
  PREUVE_COMPTE_S: 86400,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { account: { findFirst }, user: { update } },
}));

import { POST } from '@/app/api/auth/mfa/toggle/route';

const req = (enabled: boolean) =>
  new Request('http://localhost/api/auth/mfa/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });

describe('POST /api/auth/mfa/toggle sans mot de passe', () => {
  beforeEach(() => {
    findFirst.mockReset();
    update.mockClear();
  });

  it('refuse l’activation si le compte n’a aucun mot de passe', async () => {
    findFirst.mockResolvedValue(null);
    const res = await POST(req(true));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('password_required');
    expect(body.message).toMatch(/mot de passe/);
    expect(update).not.toHaveBeenCalled();
  });

  it('cherche un mot de passe réellement posé (access_token non nul)', async () => {
    findFirst.mockResolvedValue(null);
    await POST(req(true));
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      userId: 'u1',
      provider: 'credentials',
      access_token: { not: null },
    });
  });

  it('active quand un mot de passe existe', async () => {
    findFirst.mockResolvedValue({ id: 'a1' });
    const res = await POST(req(true));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { mfaEnabled: true } });
  });

  it('autorise toujours la désactivation, même sans mot de passe', async () => {
    findFirst.mockResolvedValue(null);
    const res = await POST(req(false));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalled();
  });
});
