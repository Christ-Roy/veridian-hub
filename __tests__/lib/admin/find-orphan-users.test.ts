/**
 * Tests pour lib/admin/find-orphan-users.ts
 *
 * Couvre :
 *  - Cutoff createdAt respecté (minAgeDays)
 *  - Aucune row si users récents (< cutoff)
 *  - Users sans accounts/sessions/mfaCodes ET sans tenant → orphelins
 *  - Users avec Tenant → EXCLUS (protection anti-suppression)
 *  - Calcul ageDays
 *  - Users sans supabaseUserId : pas de tenant possible → orphelins
 *  - Limit appliqué côté Prisma
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findOrphanUsers } from '@/lib/admin/find-orphan-users';

const userFindManyMock = vi.fn();
const tenantFindManyMock = vi.fn();

const mockPrisma = {
  user: { findMany: userFindManyMock },
  tenant: { findMany: tenantFindManyMock },
} as never;

beforeEach(() => {
  userFindManyMock.mockReset();
  tenantFindManyMock.mockReset();
});

describe('findOrphanUsers', () => {
  it('retourne 0 orphelin si aucun candidat', async () => {
    userFindManyMock.mockResolvedValueOnce([]);
    const result = await findOrphanUsers(mockPrisma);
    expect(result.totalOrphans).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(tenantFindManyMock).not.toHaveBeenCalled(); // pas de query tenant si rien
  });

  it('applique le cutoff createdAt < now - minAgeDays jours', async () => {
    userFindManyMock.mockResolvedValueOnce([]);
    await findOrphanUsers(mockPrisma, { minAgeDays: 30 });

    const callArgs = userFindManyMock.mock.calls[0][0];
    const cutoff = callArgs.where.createdAt.lt as Date;
    const expectedMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    // ±1s de marge pour la diff entre 2 Date.now()
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(1000);
  });

  it("filtre via accounts/sessions/mfaCodes 'none'", async () => {
    userFindManyMock.mockResolvedValueOnce([]);
    await findOrphanUsers(mockPrisma);
    const callArgs = userFindManyMock.mock.calls[0][0];
    expect(callArgs.where.accounts).toEqual({ none: {} });
    expect(callArgs.where.sessions).toEqual({ none: {} });
    expect(callArgs.where.mfaCodes).toEqual({ none: {} });
  });

  it('exclut les users avec un Tenant (protection anti-suppression)', async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    userFindManyMock.mockResolvedValueOnce([
      { id: 'u1', email: 'orphelin@x', createdAt: oldDate, supabaseUserId: 'uuid-1' },
      { id: 'u2', email: 'avec-tenant@x', createdAt: oldDate, supabaseUserId: 'uuid-2' },
    ]);
    // Tenant existe pour uuid-2 → u2 doit être exclu
    tenantFindManyMock.mockResolvedValueOnce([{ userId: 'uuid-2' }]);

    const result = await findOrphanUsers(mockPrisma);
    expect(result.totalOrphans).toBe(1);
    expect(result.orphans[0].id).toBe('u1');
  });

  it("user sans supabaseUserId n'a pas de tenant possible → orphelin", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    userFindManyMock.mockResolvedValueOnce([
      { id: 'u1', email: 'a@x', createdAt: oldDate, supabaseUserId: null },
    ]);
    // Pas de tenantFindMany car aucun supabaseUserId à check
    const result = await findOrphanUsers(mockPrisma);
    expect(result.totalOrphans).toBe(1);
    expect(result.orphans[0].id).toBe('u1');
    // tenantFindMany ne devrait pas avoir été appelé (uuidsToCheck vide)
    expect(tenantFindManyMock).not.toHaveBeenCalled();
  });

  it('calcule ageDays correctement', async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    userFindManyMock.mockResolvedValueOnce([
      { id: 'u1', email: 'a@x', createdAt: fifteenDaysAgo, supabaseUserId: null },
    ]);
    const result = await findOrphanUsers(mockPrisma);
    expect(result.orphans[0].ageDays).toBe(15);
  });

  it('respecte le limit', async () => {
    userFindManyMock.mockResolvedValueOnce([]);
    await findOrphanUsers(mockPrisma, { limit: 42 });
    const callArgs = userFindManyMock.mock.calls[0][0];
    expect(callArgs.take).toBe(42);
  });

  it('valeurs par défaut: minAgeDays=7, limit=1000', async () => {
    userFindManyMock.mockResolvedValueOnce([]);
    await findOrphanUsers(mockPrisma);
    const callArgs = userFindManyMock.mock.calls[0][0];
    expect(callArgs.take).toBe(1000);
    // 7 jours en ms
    const cutoff = callArgs.where.createdAt.lt as Date;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - sevenDaysAgo)).toBeLessThan(1000);
  });

  it('retourne scannedAt en ISO string', async () => {
    userFindManyMock.mockResolvedValueOnce([]);
    const result = await findOrphanUsers(mockPrisma);
    expect(result.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
