/**
 * Tests pour lib/admin/link-app.ts
 *
 * Couvre :
 *  - linkApp : crée un nouveau Tenant si pas existant
 *  - linkApp : update le Tenant existant (idempotent)
 *  - linkApp : metadata.<app> écrit pour cms et analytics
 *  - linkApp : colonnes dédiées pour notifuse et prospection
 *  - linkApp : préserve les autres apps déjà présentes dans metadata
 *  - unlinkApp : retire la clé metadata.<app>
 *  - unlinkApp : reset colonnes dédiées notifuse/prospection
 *  - unlinkApp : tenant pas trouvé → unlinked=false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { linkApp, unlinkApp } from '@/lib/admin/link-app';

const findFirstMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();

const prisma = {
  tenant: {
    findFirst: findFirstMock,
    create: createMock,
    update: updateMock,
  },
} as never;

beforeEach(() => {
  findFirstMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
});

const baseInput = {
  userUuid: 'uuid-1',
  externalTenantId: '1',
  externalTenantSlug: 'avse',
  tenantName: 'AVSE Monétique',
  plan: 'complimentary',
  fallbackUrl: 'https://cms.veridian.site/admin',
};

describe('linkApp — création de Tenant', () => {
  it('crée un nouveau Tenant pour app CMS si user n\'a pas de tenant', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 't-new' });

    const result = await linkApp(prisma, { ...baseInput, app: 'cms' });
    expect(result.created).toBe(true);
    expect(result.tenantId).toBe('t-new');
    expect(result.metadataPath).toBe('tenants.metadata.cms');

    const createData = createMock.mock.calls[0][0].data;
    expect(createData.userId).toBe('uuid-1');
    expect(createData.metadata.cms).toEqual(
      expect.objectContaining({
        external_tenant_id: '1',
        external_tenant_slug: 'avse',
        tenant_name: 'AVSE Monétique',
        plan: 'complimentary',
      })
    );
  });

  it('utilise les colonnes dédiées notifuse pour app=notifuse', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 't-new' });

    await linkApp(prisma, { ...baseInput, app: 'notifuse' });
    const createData = createMock.mock.calls[0][0].data;
    expect(createData.notifuseWorkspaceSlug).toBe('avse');
    expect(createData.notifusePlan).toBe('complimentary');
    expect(createData.metadata.notifuse).toBeDefined();
  });

  it('utilise prospectionPlan pour app=prospection', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 't-new' });

    await linkApp(prisma, { ...baseInput, app: 'prospection' });
    const createData = createMock.mock.calls[0][0].data;
    expect(createData.prospectionPlan).toBe('complimentary');
    expect(createData.prospectionProvisionedAt).toBeInstanceOf(Date);
  });
});

describe('linkApp — update idempotent', () => {
  it('met à jour le Tenant existant sans toucher aux autres apps', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 't-existing',
      metadata: { notifuse: { plan: 'free' } },
    });
    updateMock.mockResolvedValueOnce({ id: 't-existing' });

    const result = await linkApp(prisma, { ...baseInput, app: 'cms' });
    expect(result.created).toBe(false);
    expect(result.tenantId).toBe('t-existing');

    const updateData = updateMock.mock.calls[0][0].data;
    // Notifuse préservé
    expect(updateData.metadata.notifuse).toEqual({ plan: 'free' });
    // CMS ajouté
    expect(updateData.metadata.cms).toBeDefined();
    expect(updateData.metadata.cms.external_tenant_slug).toBe('avse');
  });

  // Anti-régression E2E spec 13 S6 (2026-05-23) :
  // « link 2× même tenant → mêmes IDs (pas de doublon) ». Le 1er call doit
  // créer (created=true), le 2e doit reprendre la même row (created=false,
  // tenantId identique). Si ce contrat casse, on duplique des Tenants en
  // DB à chaque appel admin → comptes facturés en double, dashboards
  // affichant deux fois la même app, etc.
  it('link 2× consécutifs (même user/app) retournent le même tenantId — pas de doublon', async () => {
    // 1er appel : pas de tenant existant → create
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 't-shared-uuid' });

    const first = await linkApp(prisma, { ...baseInput, app: 'cms' });
    expect(first.created).toBe(true);
    expect(first.tenantId).toBe('t-shared-uuid');

    // 2e appel : le tenant existe maintenant (simulé par le mock)
    findFirstMock.mockResolvedValueOnce({
      id: 't-shared-uuid',
      metadata: {
        cms: {
          external_tenant_id: '1',
          external_tenant_slug: 'avse',
          tenant_name: 'AVSE Monétique',
        },
      },
    });
    updateMock.mockResolvedValueOnce({ id: 't-shared-uuid' });

    const second = await linkApp(prisma, {
      ...baseInput,
      app: 'cms',
      tenantName: 'AVSE Monétique V2',
    });
    expect(second.created).toBe(false);
    expect(second.tenantId).toBe('t-shared-uuid');
    expect(second.tenantId).toBe(first.tenantId);

    // Sanity : aucune création parasite au 2e appel.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

describe('unlinkApp', () => {
  it('retourne unlinked=false si tenant pas trouvé', async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const result = await unlinkApp(prisma, { userUuid: 'uuid-x', app: 'cms' });
    expect(result.unlinked).toBe(false);
    expect(result.tenantId).toBe('');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('retire la clé metadata.cms', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 't1',
      metadata: { cms: { external_tenant_slug: 'avse' }, notifuse: { plan: 'free' } },
    });
    updateMock.mockResolvedValueOnce({});

    const result = await unlinkApp(prisma, { userUuid: 'uuid-1', app: 'cms' });
    expect(result.unlinked).toBe(true);
    const updateData = updateMock.mock.calls[0][0].data;
    expect(updateData.metadata.cms).toBeUndefined();
    expect(updateData.metadata.notifuse).toEqual({ plan: 'free' });
  });

  it('reset les colonnes dédiées notifuse quand app=notifuse', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 't1',
      metadata: { notifuse: { plan: 'pro' } },
    });
    updateMock.mockResolvedValueOnce({});

    await unlinkApp(prisma, { userUuid: 'uuid-1', app: 'notifuse' });
    const updateData = updateMock.mock.calls[0][0].data;
    expect(updateData.notifuseWorkspaceSlug).toBeNull();
    expect(updateData.notifuseUserEmail).toBeNull();
    expect(updateData.notifuseApiKey).toBeNull();
    expect(updateData.notifusePlan).toBeNull();
  });

  it('reset les colonnes dédiées prospection quand app=prospection', async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 't1',
      metadata: { prospection: { plan: 'pro' } },
    });
    updateMock.mockResolvedValueOnce({});

    await unlinkApp(prisma, { userUuid: 'uuid-1', app: 'prospection' });
    const updateData = updateMock.mock.calls[0][0].data;
    expect(updateData.prospectionApiKey).toBeNull();
    expect(updateData.prospectionPlan).toBeNull();
    expect(updateData.prospectionProvisionedAt).toBeNull();
  });

  it("unlinked=false si l'app n'était pas présente dans metadata (no-op safe)", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: 't1',
      metadata: { notifuse: { plan: 'free' } },
    });
    updateMock.mockResolvedValueOnce({});
    const result = await unlinkApp(prisma, { userUuid: 'uuid-1', app: 'cms' });
    expect(result.unlinked).toBe(false);
    expect(result.tenantId).toBe('t1');
  });
});
