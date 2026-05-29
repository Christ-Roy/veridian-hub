/**
 * Tests pour lib/tenant-apps — activation des apps gated par tenant.
 *
 * Couvre :
 *  - isGatedAppKey : twenty/analytics/cms ok, prospection/notifuse rejetés
 *  - getEnabledGatedApps : ne renvoie que les apps enabled=true, filtre les
 *    clés inconnues, fail-safe Set vide sur erreur DB (jamais de fuite)
 *  - setTenantAppEnabled : upsert avec enabledAt/enabledBy quand on active,
 *    null quand on désactive
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isGatedAppKey,
  getEnabledGatedApps,
  setTenantAppEnabled,
  GATED_APP_KEYS,
} from '@/lib/tenant-apps';

describe('isGatedAppKey', () => {
  it('accepte les apps gated', () => {
    expect(isGatedAppKey('twenty')).toBe(true);
    expect(isGatedAppKey('analytics')).toBe(true);
    expect(isGatedAppKey('cms')).toBe(true);
  });

  it('rejette les apps grand public et inconnues', () => {
    expect(isGatedAppKey('prospection')).toBe(false);
    expect(isGatedAppKey('notifuse')).toBe(false);
    expect(isGatedAppKey('bidon')).toBe(false);
    expect(isGatedAppKey('')).toBe(false);
  });

  it('GATED_APP_KEYS contient exactement twenty/analytics/cms', () => {
    expect([...GATED_APP_KEYS].sort()).toEqual(['analytics', 'cms', 'twenty']);
  });
});

describe('getEnabledGatedApps', () => {
  it('renvoie uniquement les apps enabled=true', async () => {
    const prisma = {
      tenantApp: {
        findMany: vi.fn().mockResolvedValue([
          { appKey: 'twenty' },
          { appKey: 'analytics' },
        ]),
      },
    } as never;

    const result = await getEnabledGatedApps(prisma, 'uuid-1');
    expect(result.has('twenty')).toBe(true);
    expect(result.has('analytics')).toBe(true);
    expect(result.has('cms')).toBe(false);
    // la query filtre bien sur enabled:true + le bon user
    expect((prisma as any).tenantApp.findMany).toHaveBeenCalledWith({
      where: { userId: 'uuid-1', enabled: true },
      select: { appKey: true },
    });
  });

  it('ignore les clés inconnues retournées par la DB', async () => {
    const prisma = {
      tenantApp: {
        findMany: vi.fn().mockResolvedValue([
          { appKey: 'twenty' },
          { appKey: 'legacy-garbage' },
        ]),
      },
    } as never;
    const result = await getEnabledGatedApps(prisma, 'uuid-1');
    expect(result.has('twenty')).toBe(true);
    expect(result.size).toBe(1);
  });

  it('fail-safe : Set vide sur erreur DB (jamais de fuite d\'app)', async () => {
    const prisma = {
      tenantApp: {
        findMany: vi.fn().mockRejectedValue(new Error('db down')),
      },
    } as never;
    const result = await getEnabledGatedApps(prisma, 'uuid-1');
    expect(result.size).toBe(0);
  });

  it('aucune app activée → Set vide (défaut OFF)', async () => {
    const prisma = {
      tenantApp: { findMany: vi.fn().mockResolvedValue([]) },
    } as never;
    const result = await getEnabledGatedApps(prisma, 'uuid-1');
    expect(result.size).toBe(0);
  });
});

describe('setTenantAppEnabled', () => {
  it('active : upsert avec enabled=true + enabledAt + enabledBy', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { tenantApp: { upsert } } as never;

    const res = await setTenantAppEnabled(prisma, {
      userUuid: 'uuid-1',
      appKey: 'twenty',
      enabled: true,
      actorEmail: 'admin@veridian.site',
    });

    expect(res).toEqual({ appKey: 'twenty', enabled: true });
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ userId_appKey: { userId: 'uuid-1', appKey: 'twenty' } });
    expect(arg.create.enabled).toBe(true);
    expect(arg.create.enabledAt).toBeInstanceOf(Date);
    expect(arg.create.enabledBy).toBe('admin@veridian.site');
    expect(arg.update.enabled).toBe(true);
  });

  it('désactive : enabledAt/enabledBy remis à null', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { tenantApp: { upsert } } as never;

    const res = await setTenantAppEnabled(prisma, {
      userUuid: 'uuid-1',
      appKey: 'analytics',
      enabled: false,
      actorEmail: 'admin@veridian.site',
    });

    expect(res).toEqual({ appKey: 'analytics', enabled: false });
    const arg = upsert.mock.calls[0][0];
    expect(arg.create.enabled).toBe(false);
    expect(arg.create.enabledAt).toBeNull();
    expect(arg.create.enabledBy).toBeNull();
    expect(arg.update.enabledAt).toBeNull();
  });
});
