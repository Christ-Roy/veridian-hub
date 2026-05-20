/**
 * Tests pour lib/admin/users.ts
 *
 * Couvre :
 *  - upsertHubUser : user existant → already_existed=true, pas d'écriture
 *  - upsertHubUser : user existant SANS supabaseUserId → backfill UUID
 *  - upsertHubUser : nouveau user → created=true + UUID généré
 *  - upsertHubUser : supabaseUserId fourni en input → utilisé tel quel
 *  - email lowercased et trimmed
 *  - throw si email vide
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { upsertHubUser } from '@/lib/admin/users';

const findUniqueMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();

const prisma = {
  user: {
    findUnique: findUniqueMock,
    create: createMock,
    update: updateMock,
  },
} as never;

beforeEach(() => {
  findUniqueMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
});

describe('upsertHubUser', () => {
  it('retourne already_existed=true si user existant + supabaseUserId présent', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@x.com',
      supabaseUserId: 'uuid-existing',
      name: 'Alice',
    });
    const r = await upsertHubUser(prisma, { email: 'A@X.COM' });
    expect(r).toEqual({
      userId: 'u1',
      supabaseUserId: 'uuid-existing',
      email: 'a@x.com',
      created: false,
      alreadyExisted: true,
    });
    // Aucune écriture
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('lowercase et trim email', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({
      id: 'u-new',
      email: 'alice@example.com',
      supabaseUserId: 'uuid-new',
    });
    await upsertHubUser(prisma, { email: '  Alice@Example.com  ' });
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'alice@example.com' } })
    );
  });

  it('backfill supabaseUserId si user existant sans UUID', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@x.com',
      supabaseUserId: null,
      name: null,
    });
    updateMock.mockResolvedValueOnce({});
    const r = await upsertHubUser(prisma, { email: 'a@x.com' });
    expect(r.alreadyExisted).toBe(true);
    expect(r.supabaseUserId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(updateMock).toHaveBeenCalled();
  });

  it('utilise supabaseUserId fourni en input lors du backfill', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@x.com',
      supabaseUserId: null,
      name: null,
    });
    updateMock.mockResolvedValueOnce({});
    const r = await upsertHubUser(prisma, {
      email: 'a@x.com',
      supabaseUserId: '11111111-2222-3333-4444-555555555555',
    });
    expect(r.supabaseUserId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('crée un nouveau user avec UUID frais si pas existant', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({
      id: 'u-new',
      email: 'new@x.com',
      supabaseUserId: 'uuid-new-1234',
    });
    const r = await upsertHubUser(prisma, { email: 'new@x.com', name: 'Bob' });
    expect(r.created).toBe(true);
    expect(r.alreadyExisted).toBe(false);
    expect(createMock).toHaveBeenCalled();
    const data = createMock.mock.calls[0][0].data;
    expect(data.email).toBe('new@x.com');
    expect(data.name).toBe('Bob');
    expect(data.supabaseUserId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throw si email vide ou whitespace', async () => {
    await expect(upsertHubUser(prisma, { email: '   ' })).rejects.toThrow(
      /email is required/i
    );
  });
});
