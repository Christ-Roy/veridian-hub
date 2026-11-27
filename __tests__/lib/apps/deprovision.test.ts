/**
 * Suppression d'un compte au Hub → chaque app retire l'espace (09/11 : 145 tenants Prospection
 * orphelins en 3 jours, un par run de batterie).
 */
import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const softDeleteTenant = vi.fn(async () => ({}));
vi.mock('@/lib/prospection/client', () => ({ createProspectionClientFromEnv: () => ({ softDeleteTenant }) }));

import { GRACE_JOURS, deprovisionnerCompte } from '@/lib/apps/deprovision';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

const env = {
  NOTIFUSE_API_URL: 'https://notifuse.test',
  NOTIFUSE_HUB_API_SECRET: 'sn',
  CRM_API_URL: 'https://crm.test',
  CRM_HUB_API_SECRET: 'sc',
  ACADEMY_API_URL: 'https://academy.test',
  ACADEMY_HUB_API_SECRET: 'sa',
} as NodeJS.ProcessEnv;
/** Analytics configuré : son DELETE part pour chaque organisation, notée ou non (27/11). */
const envA = { ...env, ANALYTICS_API_URL: 'https://analytics.test', ANALYTICS_HUB_API_SECRET: 'sy' } as NodeJS.ProcessEnv;
const MAINTENANT = new Date('2026-11-09T18:00:00Z');
const tenant = { id: 't1', notifuseWorkspaceSlug: 'ws1', prospectionProvisionedAt: new Date(), metadata: { crm: { workspace_id: 'w' } } };

function fetchOk(statut = 200) {
  return vi.fn(async () => new Response('{}', { status: statut }));
}

beforeEach(() => softDeleteTenant.mockClear());

describe('deprovisionnerCompte', () => {
  it('Academy : son espace est retiré avec son propre secret, à côté du CRM', async () => {
    const f = fetchOk();
    const t = { ...tenant, notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: { crm: { workspace_id: 'w' }, academy: { workspace_id: 'a' } } };
    const issues = await deprovisionnerCompte({ email: 'r@exemple.fr', tenants: [t] }, { env, fetchImpl: f as never, maintenant: () => MAINTENANT });
    const appels = f.mock.calls as unknown as [string, RequestInit][];
    expect(appels.map(([u, i]) => `${i.method} ${u}`)).toEqual(['DELETE https://crm.test/api/tenants/t1', 'DELETE https://academy.test/api/tenants/t1']);
    const [, init] = appels[1];
    const h = init.headers as Record<string, string>;
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 'sa').update(`${h['X-Veridian-Timestamp']}.`).digest('hex'));
    expect(issues.filter((i) => i.app === 'academy')).toEqual([{ app: 'academy', cible: 't1', ok: true, detail: 'http_200' }]);
  });

  it('Analytics : son organisation est retirée (27/11 : organisation, membres et fils Mon IA restaient) ; le mode rendu est gardé', async () => {
    const f = vi.fn(async () => new Response('{"deleted":false,"mode":"conserve"}', { status: 200 }));
    const t = { ...tenant, notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: { analytics: { workspace_id: 'o' } } };
    const issues = await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [t] }, { env: envA, fetchImpl: f as never, maintenant: () => MAINTENANT });
    expect((f.mock.calls as unknown as [string, RequestInit][]).map(([u, i]) => `${i.method} ${u}`)).toEqual(['DELETE https://analytics.test/api/tenants/t1']);
    expect(issues).toEqual([{ app: 'analytics', cible: 't1', ok: true, detail: 'http_200 conserve' }]);
  });

  it('Analytics : appelé aussi pour une organisation que le Hub n\'a pas notée (créée par Analytics à l\'entrée par le rebond) ; 404 = absent', async () => {
    const f = vi.fn(async () => new Response('{"error":"tenant_not_found"}', { status: 404 }));
    const t = { ...tenant, notifuseWorkspaceSlug: null, prospectionProvisionedAt: null, metadata: {} };
    const issues = await deprovisionnerCompte({ email: 'e2e-sso-x@veridian.site', tenants: [t] }, { env: envA, fetchImpl: f as never, maintenant: () => MAINTENANT });
    expect(issues).toEqual([{ app: 'analytics', cible: 't1', ok: true, detail: 'http_404' }]);
  });

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

  it('le Hub pose lui-même l\'état Prospection, au succès seulement (27/11 : l\'écho tenant.soft_deleted n\'est jamais arrivé)', async () => {
    const notes: [string, Record<string, unknown>][] = [];
    const noter = async (id: string, patch: Record<string, unknown>) => { notes.push([id, patch]); };
    const sans = { ...tenant, id: 't2', prospectionProvisionedAt: null };
    await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant, sans] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT, noter });
    expect(notes).toEqual([['t1', { prospection_status: 'deleted', prospection_soft_deleted_at: MAINTENANT.toISOString(), prospection_soft_deleted_reason: 'admin_action', prospection_purge_eligible_at: new Date(MAINTENANT.getTime() + GRACE_JOURS * 86_400_000).toISOString() }]]);
    // Refusé par Prospection : rien n'est noté, l'échec est dit.
    notes.length = 0;
    softDeleteTenant.mockRejectedValueOnce(new Error('HTTP 500 boom'));
    const i2 = await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT, noter });
    expect([notes, i2.find((x) => x.app === 'prospection')?.ok]).toEqual([[], false]);
    // Déjà absent chez Prospection : supprimé pour le Hub, sans date de purge.
    softDeleteTenant.mockRejectedValueOnce(new Error('HTTP 404 tenant_not_found'));
    await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT, noter });
    expect(notes.map(([id, p]) => [id, p.prospection_status, 'prospection_purge_eligible_at' in p])).toEqual([['t1', 'deleted', false]]);
    // Une note ratée ne défait pas la suppression : elle est dite.
    const i4 = await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT, noter: async () => { throw new Error('base'); } });
    expect(i4.find((x) => x.app === 'prospection')).toMatchObject({ ok: true, detail: expect.stringContaining('état non noté au Hub sur 1 tenant') });
    // La base n'a rien changé (tenant absent) : c'est un échec de la note, dit comme tel ; une ligne changée : dite aussi.
    const i5 = await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT, noter: async () => 0 });
    expect(i5.find((x) => x.app === 'prospection')?.detail).toContain('état non noté au Hub sur 1 tenant');
    const i6 = await deprovisionnerCompte({ email: 'client@exemple.fr', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT, noter: async () => 1 });
    expect(i6.find((x) => x.app === 'prospection')?.detail).toContain('état noté au Hub (1 tenant)');
  });

  it('compte de test : purge Prospection éligible tout de suite', async () => {
    await deprovisionnerCompte({ email: 'e2e-sso-abc-mcp@veridian.site', tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT });
    expect((softDeleteTenant.mock.calls[0] as unknown as [string, { purgeEligibleAt: string }])[1].purgeEligibleAt).toBe(MAINTENANT.toISOString());
  });

  it('une adresse de client qui RESSEMBLE à une adresse d\'épreuve garde ses 90 jours (motif partagé avec l\'envoi de mails)', async () => {
    for (const email of ['e2e-sso-x@client.fr', 'e2e-sso-x@veridian.site.client.fr']) {
      softDeleteTenant.mockClear();
      await deprovisionnerCompte({ email, tenants: [tenant] }, { env, fetchImpl: fetchOk() as never, maintenant: () => MAINTENANT });
      expect((softDeleteTenant.mock.calls[0] as unknown as [string, { purgeEligibleAt: string }])[1].purgeEligibleAt, email).toBe(new Date(MAINTENANT.getTime() + 90 * 86_400_000).toISOString());
    }
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

describe('deprovisionnerCompte, version de signature', () => {
  const retirer = async () => {
    const f = fetchOk();
    await deprovisionnerCompte({ email: 'c@d.e', tenants: [{ ...tenant, notifuseWorkspaceSlug: null, prospectionProvisionedAt: null }] }, { env, fetchImpl: f as never, maintenant: () => MAINTENANT });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    return { url, h: init.headers as Record<string, string> };
  };
  it('HMAC_V2_APPS=crm : le DELETE du CRM part en v2, lié à la méthode et au tenant du chemin', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'crm');
    try {
      const { url, h } = await retirer();
      exigeV2(h, 'sc', 'DELETE', url);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('variable absente : v1, sans en-tête de version', async () => {
    const { h } = await retirer();
    exigeV1(h, 'sc');
  });
});
