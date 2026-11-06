import { beforeEach, describe, expect, it, vi } from 'vitest';

const { discover, updatePlan } = vi.hoisted(() => ({ discover: vi.fn(), updatePlan: vi.fn() }));

vi.mock('@/lib/sync/discovery', () => ({ discoverAppForEmail: discover }));
vi.mock('@/lib/prospection/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/prospection/client')>()),
  createProspectionClientFromEnv: () => ({ updatePlan }),
}));

import { ProspectionError } from '@/lib/prospection/client';
import { pushProspectionPlan } from '@/lib/prospection/plan-push';

const input = { hubTenantId: 'hub-1', email: 'a@x.fr', plan: 'enterprise', planSource: 'grant_manual' as const };
const ws = (tenantId: string | undefined, role = 'admin') => ({ tenantId, role });

describe('pushProspectionPlan', () => {
  beforeEach(() => {
    discover.mockReset();
    updatePlan.mockReset();
  });

  it('cible le tenant unique, avec le plan canonique', async () => {
    discover.mockResolvedValue({ found: true, snapshots: [ws('p-1')] });
    expect(await pushProspectionPlan({ ...input, plan: 'freemium' })).toEqual({
      ok: true,
      prospectionTenantId: 'p-1',
    });
    expect(updatePlan).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'p-1', plan: 'free' }));
  });

  it('préfère le tenant de même id que le Hub', async () => {
    discover.mockResolvedValue({ found: true, snapshots: [ws('p-1'), ws('hub-1')] });
    await pushProspectionPlan(input);
    expect(updatePlan).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'hub-1' }));
  });

  it.each([
    ['deux tenants possibles', { found: true, snapshots: [ws('p-1'), ws('p-2')] }, 'prospection_tenant_ambiguous'],
    ['tenant_id absent', { found: true, snapshots: [ws(undefined)] }, 'prospection_tenant_id_unknown'],
    ['simple membre', { found: true, snapshots: [ws('p-1', 'member')] }, 'prospection_tenant_id_unknown'],
    ['inconnu de l\'app', { found: false }, 'user_not_in_app'],
  ])('refuse sans écrire : %s', async (_label, discovery, error) => {
    discover.mockResolvedValue(discovery);
    expect(await pushProspectionPlan(input)).toEqual({ ok: false, error });
    expect(updatePlan).not.toHaveBeenCalled();
  });

  it('refuse un plan hors du contrat', async () => {
    expect(await pushProspectionPlan({ ...input, plan: 'starter' })).toMatchObject({ ok: false });
    expect(discover).not.toHaveBeenCalled();
  });

  it('un plan offert (409) reste immune, un autre refus remonte', async () => {
    discover.mockResolvedValue({ found: true, snapshots: [ws('p-1')] });
    updatePlan.mockRejectedValueOnce(new ProspectionError('immune', 409, null));
    expect(await pushProspectionPlan({ ...input, planSource: 'stripe' })).toEqual({ ok: true, immune: true });
    updatePlan.mockRejectedValueOnce(new ProspectionError('boom', 500, null));
    expect(await pushProspectionPlan(input)).toMatchObject({ ok: false });
  });
});
