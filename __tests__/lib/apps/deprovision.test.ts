/**
 * Suppression d'un compte au Hub → chaque app retire l'espace (09/11 : 145 tenants Prospection
 * orphelins en 3 jours, un par run de batterie).
 */
import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const softDeleteTenant = vi.fn(async () => ({}));
vi.mock('@/lib/prospection/client', () => ({ createProspectionClientFromEnv: () => ({ softDeleteTenant }) }));

import { GRACE_JOURS, deprovisionnerCompte } from '@/lib/apps/deprovision';

const env = {
  NOTIFUSE_API_URL: 'https://notifuse.test',
  NOTIFUSE_HUB_API_SECRET: 'sn',
  CRM_API_URL: 'https://crm.test',
  CRM_HUB_API_SECRET: 'sc',
} as NodeJS.ProcessEnv;
const MAINTENANT = new Date('2026-11-09T18:00:00Z');
const tenant = { id: 't1', notifuseWorkspaceSlug: 'ws1', prospectionProvisionedAt: new Date(), metadata: { crm: { workspace_id: 'w' } } };

function fetchOk(statut = 200) {
  return vi.fn(async () => new Response('{}', { status: statut }));
}

beforeEach(() => softDeleteTenant.mockClear());

describe('deprovisionnerCompte', () => {
  it('client réel : Prospection soft-delete à 90 jours, Notifuse (DELETE, soft-delete chez lui) et Twenty retirés', async () => {
    const f = fetchOk();
    const issues = await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant] }, { env, fetchImpl: f as never, maintenant: () => MAINTENANT });
    expect(softDeleteTenant).toHaveBeenCalledWith('client@exemple.fr', {
      purgeEligibleAt: new Date(MAINTENANT.getTime() + GRACE_JOURS * 86_400_000).toISOString(),
      reason: 'admin_action',
    });
    const urls = f.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${c[0]}`);
    expect(urls).toEqual(['DELETE https://notifuse.test/api/tenants/ws1', 'DELETE https://crm.test/api/tenants/t1']);
    expect(issues.map((i) => [i.app, i.ok])).toEqual([['prospection', true], ['notifuse', true], ['crm', true]]);
  });

  it('compte de test : purge Prospection éligible tout de suite', async () => {
    await deprovisionnerCompte({ email: 'e2e-sso-abc-mcp@veridian.site', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT });
    expect((softDeleteTenant.mock.calls[0] as unknown as [string, { purgeEligibleAt: string }])[1].purgeEligibleAt).toBe(MAINTENANT.toISOString());
  });

  it('Twenty : DELETE signé HMAC sur `${ts}.` (corps vide)', async () => {
    const f = fetchOk();
    await deprovisionnerCompte({ email: 'c@d.e', tenants: [{ ...tenant, notifuseWorkspaceSlug: null, prospectionProvisionedAt: null }] }, { env, fetchImpl: f as never, maintenant: () => MAINTENANT });
    const h = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 'sc').update(`${h['X-Veridian-Timestamp']}.`).digest('hex'));
  });

  it('espace déjà absent (404) : pas un échec', async () => {
    const issues = await deprovisionnerCompte({ email: 'c@d.e', tenants: [{ ...tenant, prospectionProvisionedAt: null }] }, { env, fetchImpl: fetchOk(404) as never });
    expect(issues.every((i) => i.ok)).toBe(true);
  });

  it('app en erreur : rendue en échec, sans lever (la suppression au Hub continue)', async () => {
    softDeleteTenant.mockRejectedValueOnce(new Error('HTTP 500 boom'));
    const issues = await deprovisionnerCompte({ email: 'c@d.e', tenants: [{ ...tenant, notifuseWorkspaceSlug: null, metadata: {} }] }, { env, fetchImpl: fetchOk() as never });
    expect(issues).toEqual([expect.objectContaining({ app: 'prospection', ok: false })]);
  });

  it('rien chez les apps : aucun appel', async () => {
    const f = fetchOk();
    const issues = await deprovisionnerCompte({ email: 'c@d.e', tenants: [{ id: 't', notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: {} }] }, { env, fetchImpl: f as never });
    expect(issues).toEqual([]);
    expect(f).not.toHaveBeenCalled();
    expect(softDeleteTenant).not.toHaveBeenCalled();
  });
});
