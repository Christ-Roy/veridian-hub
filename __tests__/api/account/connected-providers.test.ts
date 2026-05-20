/**
 * Tests pour GET /api/account/connected-providers
 *
 * Couvre :
 *  - Retourne la liste des providers du user
 *  - Filtre bien par userId (jamais d'autre user)
 *  - Ne fuite jamais les tokens (access/refresh/id_token)
 *  - Liste vide quand pas de provider
 *
 * Le DELETE [provider] est testé dans connected-providers/[provider].test.ts
 * (convention 1-pour-1 — un fichier source = un fichier test colocalisé).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyMock = vi.fn();

vi.mock('@/lib/auth/get-user', () => ({
  requireUser: vi.fn(async () => ({
    id: 'u1',
    email: 'alice@example.com',
    supabaseUserId: 'uuid-u1',
  })),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    account: {
      findMany: (...args: unknown[]) => findManyMock(...args),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/account/connected-providers', () => {
  it('retourne les providers du user sans fuiter les tokens', async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 'a1', provider: 'google', providerAccountId: 'g-123', type: 'oauth' },
      { id: 'a2', provider: 'credentials', providerAccountId: 'alice@example.com', type: 'credentials' },
    ]);

    const { GET } = await import('@/app/api/account/connected-providers/route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]).toEqual({
      id: 'a1',
      provider: 'google',
      providerAccountId: 'g-123',
      type: 'oauth',
    });
    // Vérifie qu'aucun champ token n'est exposé
    expect(body.providers[0]).not.toHaveProperty('access_token');
    expect(body.providers[0]).not.toHaveProperty('refresh_token');
    expect(body.providers[0]).not.toHaveProperty('id_token');

    // Vérifie que findMany a bien filtré par userId
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } })
    );
  });

  it('retourne une liste vide si aucun provider', async () => {
    findManyMock.mockResolvedValueOnce([]);
    const { GET } = await import('@/app/api/account/connected-providers/route');
    const res = await GET();
    const body = await res.json();
    expect(body.providers).toEqual([]);
  });
});
