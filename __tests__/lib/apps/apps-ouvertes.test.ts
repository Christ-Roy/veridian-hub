/** Quelles apps sont ouvertes : la vérité partagée par la page et le sélecteur de l'en-tête. */
import { describe, expect, it } from 'vitest';

import { appsOuvertes, etatApps } from '@/lib/apps/apps-ouvertes';

const ENV = { CRM_API_URL: 'https://crm.test', NOTIFUSE_API_URL: 'https://mail.test', NEXT_PUBLIC_PROSPECTION_URL: 'https://p.test', ACADEMY_API_URL: 'https://a.test' } as never;
const vide = new Set<string>();

describe('etatApps', () => {
  it('compte neuf : seul le CRM est ouvert à tout compte', () => {
    const e = etatApps({ tenant: null, activees: vide, env: ENV });
    expect(e).toMatchObject({ crm: true, prospection: false, notifuse: false, analytics: false, cms: false, academy: false });
  });
  it('Academy : réservée, sans activation pas de tuile ; activée mais non branchée, rien non plus', () => {
    expect(etatApps({ tenant: null, activees: vide, env: ENV }).academy).toBe(false);
    expect(etatApps({ tenant: null, activees: new Set(['academy']), env: ENV }).academy).toBe(true);
    expect(etatApps({ tenant: null, activees: new Set(['academy']), env: {} as never }).academy).toBe(false);
  });
  it('Prospection et Mail : provisionnés ; Mail jamais sur une adresse locale', () => {
    const tenant = { prospectionProvisionedAt: new Date(), notifuseWorkspaceSlug: 'x' };
    expect(etatApps({ tenant, activees: vide, env: ENV })).toMatchObject({ prospection: true, notifuse: true });
    expect(etatApps({ tenant, activees: vide, env: { NOTIFUSE_API_URL: 'http://localhost:3000' } as never }).notifuse).toBe(false);
  });
  it('Analytics : activation, plan site vitrine, note du tenant ou un site découvert ; CMS : activation ou note', () => {
    expect(etatApps({ tenant: null, activees: new Set(['analytics']), env: ENV }).analytics).toBe(true);
    expect(etatApps({ tenant: { notifusePlan: 'lifetime_site_vitrine' }, activees: vide, env: ENV }).analytics).toBe(true);
    expect(etatApps({ tenant: { metadata: { analytics: { fallback_url: 'https://an.test' } } }, activees: vide, env: ENV }).analytics).toBe(true);
    expect(etatApps({ tenant: null, activees: vide, sitesAnalytics: 1, env: ENV }).analytics).toBe(true);
    expect(etatApps({ tenant: null, activees: vide, sitesAnalytics: 0, env: ENV }).analytics).toBe(false);
    expect(etatApps({ tenant: null, activees: vide, env: ENV }).cms).toBe(false);
    expect(etatApps({ tenant: null, activees: new Set(['cms']), env: ENV }).cms).toBe(true);
  });
});

describe('appsOuvertes', () => {
  it('les apps ouvertes seulement, CRM / Mail / Prospection par le rebond signé, jamais un jeton', () => {
    const l = appsOuvertes({ tenant: { prospectionProvisionedAt: new Date(), notifuseWorkspaceSlug: 'x' }, activees: vide, env: ENV });
    expect(l.map((a) => a.cle)).toEqual(['prospection', 'notifuse', 'crm']);
    expect(l.map((a) => a.href)).toEqual([
      '/login?next=https%3A%2F%2Fp.test%2F',
      '/login?next=https%3A%2F%2Fmail.test%2Fconsole%2F',
      '/login?next=https%3A%2F%2Fcrm.test%2F',
    ]);
    expect(JSON.stringify(l)).not.toMatch(/token|jeton|key=/i);
  });
  it('Academy absente sans activation, présente avec', () => {
    expect(appsOuvertes({ tenant: null, activees: vide, env: ENV }).map((a) => a.cle)).not.toContain('academy');
    expect(appsOuvertes({ tenant: null, activees: new Set(['academy']), env: ENV }).map((a) => a.cle)).toContain('academy');
  });
  it('Analytics prend l\'adresse de la carte ; sans adresse, pas de lien', () => {
    const e = { tenant: null, activees: new Set(['analytics']), env: ENV };
    expect(appsOuvertes(e, 'https://an.test/site').find((a) => a.cle === 'analytics')?.href).toBe('https://an.test/site');
    expect(appsOuvertes(e).find((a) => a.cle === 'analytics')).toBeUndefined();
  });
});
