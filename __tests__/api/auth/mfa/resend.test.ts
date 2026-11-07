/**
 * D3 : le renvoi du code exige le cookie d'étape 1. Avant : n'importe quel `userId` recevait un code.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { findUniqueMock, issueMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  issueMock: vi.fn(async () => undefined),
}));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: findUniqueMock } } }));
vi.mock('@/lib/mfa', () => ({
  issueAndSendMfaCode: issueMock,
  MfaRateLimitError: class extends Error {},
}));

import { POST } from '@/app/api/auth/mfa/resend/route';
import { signerEtapeUn, mfaStep1CookieName } from '@/lib/auth/mfa-step1';

const SECRET = 'secret-de-test-au-moins-32-octets-xxxxxxxx';

function req(body: unknown, cookie?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  return { headers, json: async () => body } as unknown as Request;
}

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});
beforeEach(() => {
  issueMock.mockClear();
  findUniqueMock.mockResolvedValue({ id: 'u5', email: 'a@b.fr', mfaEnabled: true });
});

describe('POST /api/auth/mfa/resend (D3)', () => {
  it('sans cookie d\'étape 1 : 401, aucun code envoyé, même avec un userId', async () => {
    const res = await POST(req({ userId: 'victime' }));
    expect(res.status).toBe(401);
    expect(issueMock).not.toHaveBeenCalled();
  });

  it('avec le cookie : le code part pour l\'utilisateur du cookie, pas pour le corps', async () => {
    const cookie = `${mfaStep1CookieName(false)}=${signerEtapeUn('u5', Math.floor(Date.now() / 1000), SECRET)}`;
    const res = await POST(req({ userId: 'victime' }, cookie));
    expect(res.status).toBe(200);
    expect(issueMock).toHaveBeenCalledWith({ id: 'u5', email: 'a@b.fr' });
  });
});
