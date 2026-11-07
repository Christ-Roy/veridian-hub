/**
 * D11 : mot de passe borné comme à l'inscription (8 à 72 caractères, bcrypt tronque au-delà de
 * 72 octets), et changement via les réglages : les jetons de reset encore en attente tombent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deleteManyMock, revokeMock } = vi.hoisted(() => ({
  deleteManyMock: vi.fn(async () => ({ count: 0 })),
  revokeMock: vi.fn(async () => ({ appsEnEchec: [] as string[] })),
}));

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: async () => ({ id: 'u1', email: 'moi@x.fr', supabaseUserId: null }),
}));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('@/lib/auth/recent-auth', () => ({
  denyIfImpersonated: async () => null,
  denyUnlessRecentAuth: async () => null,
  PREUVE_COMPTE_S: 86400,
}));
vi.mock('@/lib/auth/session-revocation', () => ({ revokeAllSessions: revokeMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    account: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    verificationToken: { deleteMany: deleteManyMock },
  },
}));

import { POST } from '@/app/api/account/password/route';

function req(body: unknown) {
  return new Request('http://localhost/api/account/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/password (D11)', () => {
  beforeEach(() => {
    deleteManyMock.mockClear();
    revokeMock.mockClear();
  });

  it('refuse un mot de passe de 7 caractères (minimum 8, comme à l\'inscription)', async () => {
    expect((await POST(req({ newPassword: 'abcdefg' }))).status).toBe(400);
  });

  it('refuse un mot de passe de 73 caractères (bcrypt ne lit que 72 octets)', async () => {
    expect((await POST(req({ newPassword: 'a'.repeat(73) }))).status).toBe(400);
  });

  it('un changement valide supprime les jetons de reset en attente du compte', async () => {
    const res = await POST(req({ newPassword: 'nouveaupass1' }));
    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { identifier: 'moi@x.fr' } });
    expect(revokeMock).toHaveBeenCalled();
  });
});
