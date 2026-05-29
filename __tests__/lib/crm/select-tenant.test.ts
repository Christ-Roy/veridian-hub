/**
 * Tests pour lib/crm/select-tenant.ts.
 *
 * Couvre :
 *  - getCrmTenantByUserId : filtre status != 'deleted', orderBy createdAt desc
 *  - getCrmTenantByEmail : normalise email (lowercase + trim), filtre 'deleted'
 *  - getCrmTenantById : passthrough findUnique, retourne row brute (avec
 *    colonnes chiffrées car le caller en a besoin)
 *  - aucune des fonctions ne déchiffre — c'est la responsabilité du caller
 *  - signature `(id, prisma?)` : prisma optionnel pour faciliter Agent D
 *    (page dashboard appelle juste `getCrmTenantByUserId(userUuid)`)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirstMock, findUniqueMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    crmTenant: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
    },
  },
}));

import {
  getCrmTenantById,
  getCrmTenantByEmail,
  getCrmTenantByUserId,
} from '@/lib/crm/select-tenant';

const prismaMock = {
  crmTenant: {
    findFirst: findFirstMock,
    findUnique: findUniqueMock,
  },
} as never;

const sampleRow = {
  id: 'tenant-uuid',
  userId: 'user-uuid',
  email: 'a@b.com',
  workspaceDisplayName: 'Acme',
  twentyWorkspaceId: 'twenty-ws-uuid',
  twentyWorkspaceUrl: 'https://acme.crm/',
  twentyApiKeyId: 'apikey-uuid',
  twentyApiKeyEncrypted: 'iv.tag.ct',
  twentyApiKeyExpiresAt: new Date('2027-05-27T12:00:00Z'),
  twentyPasswordEncrypted: 'iv.tag.ct',
  status: 'active',
  metadata: null,
  provisionedAt: new Date('2026-05-27T12:00:00Z'),
  createdAt: new Date('2026-05-27T12:00:00Z'),
  updatedAt: new Date('2026-05-27T12:00:00Z'),
};

beforeEach(() => {
  findFirstMock.mockReset();
  findUniqueMock.mockReset();
});

describe('getCrmTenantByUserId', () => {
  it('returns safe view (no encrypted secrets) for active tenant', async () => {
    findFirstMock.mockResolvedValueOnce(sampleRow);
    const result = await getCrmTenantByUserId('user-uuid', prismaMock);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('tenant-uuid');
    expect(result).not.toHaveProperty('twentyApiKeyEncrypted');
    expect(result).not.toHaveProperty('twentyPasswordEncrypted');
  });

  it('filters status != deleted + orderBy createdAt desc', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    await getCrmTenantByUserId('user-uuid', prismaMock);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { userId: 'user-uuid', status: { not: 'deleted' } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns null when userUuid is empty (no DB query)', async () => {
    const result = await getCrmTenantByUserId('', prismaMock);
    expect(result).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns null when no row matches', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const result = await getCrmTenantByUserId('user-uuid', prismaMock);
    expect(result).toBeNull();
  });

  it('falls back to default prisma singleton when not passed (Agent D contract)', async () => {
    findFirstMock.mockResolvedValueOnce(sampleRow);
    // Pas de prisma explicite — utilise le singleton mocké via vi.mock
    const result = await getCrmTenantByUserId('user-uuid');
    expect(result?.id).toBe('tenant-uuid');
    expect(findFirstMock).toHaveBeenCalled();
  });
});

describe('getCrmTenantByEmail', () => {
  it('normalizes email (lowercase + trim) before lookup', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    await getCrmTenantByEmail('  Robert@Example.COM ', prismaMock);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { email: 'robert@example.com', status: { not: 'deleted' } },
    });
  });

  it('returns null when email is empty/whitespace', async () => {
    const result = await getCrmTenantByEmail('   ', prismaMock);
    expect(result).toBeNull();
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it('returns safe view (no secrets) when row found', async () => {
    findFirstMock.mockResolvedValueOnce(sampleRow);
    const result = await getCrmTenantByEmail('a@b.com', prismaMock);
    expect(result?.email).toBe('a@b.com');
    expect(result).not.toHaveProperty('twentyApiKeyEncrypted');
  });
});

describe('getCrmTenantById', () => {
  it('returns raw row (with encrypted fields) — caller decrypts explicitly', async () => {
    findUniqueMock.mockResolvedValueOnce(sampleRow);
    const result = await getCrmTenantById('tenant-uuid', prismaMock);
    expect(result?.twentyApiKeyEncrypted).toBe('iv.tag.ct');
    expect(result?.twentyPasswordEncrypted).toBe('iv.tag.ct');
  });

  it('returns null when id is empty (no DB query)', async () => {
    const result = await getCrmTenantById('', prismaMock);
    expect(result).toBeNull();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it('returns null when not found', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const result = await getCrmTenantById('missing', prismaMock);
    expect(result).toBeNull();
  });
});
