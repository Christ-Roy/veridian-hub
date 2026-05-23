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
 *  - **race-condition** : findUnique=null mais create P2002 → relit +
 *    retourne already_existed (raceConditionResolved=true), pas 500
 *  - race avec relecture vide → re-throw l'erreur initiale (cas pathologique)
 *  - autre code Prisma (P1001 timeout) → re-throw, jamais masqué
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

  it('race condition : findUnique=null mais create P2002 → relit + already_existed', async () => {
    // Path d'exécution réel d'une race : findUnique avant create voit
    // null, le create plante P2002 car un autre appel concurrent a
    // committé entre les deux. On doit relire et retourner
    // already_existed=true, jamais throw.
    findUniqueMock
      .mockResolvedValueOnce(null) // findUnique initial : pas trouvé
      .mockResolvedValueOnce({
        // findUnique post-race : trouvé (autre call a committé)
        id: 'u-raced',
        email: 'race@x.com',
        supabaseUserId: 'uuid-raced',
        name: null,
      });
    const p2002 = Object.assign(new Error('Unique constraint'), {
      code: 'P2002',
    });
    createMock.mockRejectedValueOnce(p2002);

    const r = await upsertHubUser(prisma, { email: 'race@x.com' });
    expect(r).toMatchObject({
      userId: 'u-raced',
      supabaseUserId: 'uuid-raced',
      email: 'race@x.com',
      created: false,
      alreadyExisted: true,
      raceConditionResolved: true,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(2);
    // Pas de backfill puisque supabaseUserId déjà présent côté raced
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('race condition + backfill : P2002 + raced sans supabaseUserId → backfill UUID', async () => {
    findUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'u-raced',
        email: 'race@x.com',
        supabaseUserId: null, // legacy : pas de UUID encore
        name: null,
      });
    const p2002 = Object.assign(new Error('Unique constraint'), {
      code: 'P2002',
    });
    createMock.mockRejectedValueOnce(p2002);
    updateMock.mockResolvedValueOnce({});

    const r = await upsertHubUser(prisma, { email: 'race@x.com' });
    expect(r.raceConditionResolved).toBe(true);
    expect(r.alreadyExisted).toBe(true);
    expect(r.supabaseUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(updateMock).toHaveBeenCalled();
  });

  it('race condition + relecture vide → re-throw P2002 initial (pas masquer)', async () => {
    // Cas pathologique : P2002 sur create mais findUnique post-race
    // retourne null (ex. P2002 sur un autre champ unique, ou row supprimé
    // entre-temps). On ne doit PAS retourner already_existed faussement —
    // on re-throw pour que la route renvoie 500 et qu'on voie le vrai bug.
    findUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const p2002 = Object.assign(new Error('Unique constraint'), {
      code: 'P2002',
    });
    createMock.mockRejectedValueOnce(p2002);

    await expect(
      upsertHubUser(prisma, { email: 'race@x.com' })
    ).rejects.toBe(p2002);
  });

  it('autre erreur Prisma (P1001 timeout) → re-throw, jamais masqué', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const p1001 = Object.assign(new Error('Connection refused'), {
      code: 'P1001',
    });
    createMock.mockRejectedValueOnce(p1001);

    await expect(
      upsertHubUser(prisma, { email: 'a@x.com' })
    ).rejects.toBe(p1001);
    // On n'a PAS tenté de relire — l'erreur n'est pas une race.
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });

  it('erreur sans code (non-Prisma) → re-throw', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const generic = new Error('boom');
    createMock.mockRejectedValueOnce(generic);

    await expect(upsertHubUser(prisma, { email: 'a@x.com' })).rejects.toBe(
      generic
    );
  });
});
