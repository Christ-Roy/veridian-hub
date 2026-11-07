/**
 * D6 : l'adresse est normalisée (trim, minuscules) au changement de profil. La base stocke
 * les adresses en minuscules : un changement en majuscules ne doit ni échapper au contrôle
 * de doublon, ni être stocké tel quel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { users, updateMock } = vi.hoisted(() => ({
  users: new Map<string, { id: string; email: string }>(),
  updateMock: vi.fn(async () => ({})),
}));

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: async () => ({ id: 'u1', email: 'moi@x.fr', name: 'Moi', supabaseUserId: null }),
}));
vi.mock('@/lib/auth/recent-auth', () => ({
  denyUnlessRecentAuth: async () => null,
  PREUVE_COMPTE_S: 86400,
}));
vi.mock('@/lib/auth/email-proof', () => ({ issueEmailProof: vi.fn(async () => true) }));
vi.mock('@/lib/identity/push-user', () => ({ pushUserToApps: vi.fn(async () => ({})) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      // Base réelle : adresses stockées en minuscules. Une recherche exacte échoue sur `A@X`.
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
      update: updateMock,
    },
    account: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

import { PATCH } from '@/app/api/account/profile/route';

function req(body: unknown) {
  return new Request('http://localhost/api/account/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/account/profile : email normalisé (D6)', () => {
  beforeEach(() => {
    users.clear();
    users.set('moi@x.fr', { id: 'u1', email: 'moi@x.fr' });
    users.set('victime@x.fr', { id: 'u2', email: 'victime@x.fr' });
    updateMock.mockClear();
  });

  it('une adresse déjà prise en majuscules donne 409 (même adresse, autre casse)', async () => {
    const res = await PATCH(req({ email: 'Victime@X.fr' }));
    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('une adresse saisie avec espaces et majuscules est stockée normalisée', async () => {
    const res = await PATCH(req({ email: '  Nouvelle@X.fr ' }));
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'nouvelle@x.fr' }) }),
    );
  });
});
