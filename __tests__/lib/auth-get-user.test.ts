/**
 * Tests unit pour lib/auth/get-user.ts
 *
 * Couvre :
 *  - getCurrentUser() retourne null sans session
 *  - getCurrentUser() retourne null si session.user.id absent
 *  - getCurrentUser() retourne null si Prisma renvoie null (user supprimé
 *    mais session encore valide — edge case post-cleanup compte)
 *  - getCurrentUser() retourne l'AuthUser quand tout est OK
 *  - requireUser() throw Response 401 si pas de user
 *  - requireUser() retourne le user si auth OK
 *  - userUuid() throw si supabaseUserId est null
 *  - userUuid() retourne le supabaseUserId sinon
 *
 * Mocks @/auth (auth()) + @/lib/prisma (prisma.user.findUnique).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks DOIVENT être définis AVANT l'import du module testé.
// vi.mock est hoisted automatiquement, donc l'ordre du code source n'importe
// pas, mais la convention est de les mettre en haut.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

// Imports APRÈS les mocks
import { getCurrentUser, requireUser, userUuid } from '@/lib/auth/get-user';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

const mockedAuth = vi.mocked(auth);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedFindUnique = vi.mocked(prisma.user.findUnique) as any;

describe('getCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when there is no session', async () => {
    mockedAuth.mockResolvedValueOnce(null);
    const user = await getCurrentUser();
    expect(user).toBeNull();
    // Should NOT hit Prisma — short-circuit on missing session.
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it('returns null when session.user.id is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValueOnce({ user: {} } as any);
    const user = await getCurrentUser();
    expect(user).toBeNull();
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it('returns null when Prisma cannot find the user (deleted account)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValueOnce({ user: { id: 'ghost-id' } } as any);
    mockedFindUnique.mockResolvedValueOnce(null);
    const user = await getCurrentUser();
    expect(user).toBeNull();
    expect(mockedFindUnique).toHaveBeenCalledWith({
      where: { id: 'ghost-id' },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        supabaseUserId: true,
      },
    });
  });

  it('returns the AuthUser when session + Prisma both resolve', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValueOnce({ user: { id: 'user-123' } } as any);
    const prismaUser = {
      id: 'user-123',
      email: 'robert@veridian.site',
      name: 'Robert',
      image: null,
      supabaseUserId: '00000000-0000-0000-0000-000000000001',
    };
    mockedFindUnique.mockResolvedValueOnce(prismaUser);

    const user = await getCurrentUser();
    expect(user).toEqual(prismaUser);
  });
});

describe('requireUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a 401 Response when no session', async () => {
    mockedAuth.mockResolvedValueOnce(null);

    try {
      await requireUser();
      throw new Error('requireUser should have thrown');
    } catch (e) {
      // requireUser throws a Response object (not a regular Error)
      expect(e).toBeInstanceOf(Response);
      const res = e as Response;
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    }
  });

  it('returns the user when session is valid', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedAuth.mockResolvedValueOnce({ user: { id: 'user-42' } } as any);
    const prismaUser = {
      id: 'user-42',
      email: 'x@y.z',
      name: null,
      image: null,
      supabaseUserId: '00000000-0000-0000-0000-000000000042',
    };
    mockedFindUnique.mockResolvedValueOnce(prismaUser);

    const user = await requireUser();
    expect(user).toEqual(prismaUser);
  });
});

describe('userUuid', () => {
  it('returns supabaseUserId when present', () => {
    const user = {
      id: 'user-1',
      email: 'a@b.c',
      name: null,
      image: null,
      supabaseUserId: '00000000-0000-0000-0000-000000000010',
    };
    expect(userUuid(user)).toBe('00000000-0000-0000-0000-000000000010');
  });

  it('throws when supabaseUserId is null', () => {
    const user = {
      id: 'orphan-user',
      email: 'a@b.c',
      name: null,
      image: null,
      supabaseUserId: null,
    };
    expect(() => userUuid(user)).toThrowError(/no supabaseUserId/);
  });
});
