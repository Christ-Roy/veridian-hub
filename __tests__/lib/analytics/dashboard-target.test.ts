import { describe, expect, it, vi } from 'vitest';

import { resolveAnalyticsCardTarget } from '@/lib/analytics/dashboard-target';

const env = { NEXT_PUBLIC_ANALYTICS_URL: 'https://analytics.app.veridian.site' } as never;

describe('resolveAnalyticsCardTarget', () => {
  it('adresse non prouvée (email null) : aucune découverte, rien de révélé', async () => {
    const discover = vi.fn();
    const r = await resolveAnalyticsCardTarget({ email: null }, { env, discover: discover as never });
    expect(discover).not.toHaveBeenCalled();
    expect(r).toMatchObject({ siteCount: 0, siteName: null, source: 'default' });
  });

  it('photo vers l\'ancien moteur mort : retour sur l\'app servie', async () => {
    const r = await resolveAnalyticsCardTarget(
      { email: null, metadataFallbackUrl: 'https://analytics-engine.app.veridian.site/x' },
      { env },
    );
    expect(r.url).toBe('https://analytics.app.veridian.site');
  });

  it('photo valable : conservée quand la découverte ne trouve rien', async () => {
    const r = await resolveAnalyticsCardTarget(
      { email: null, metadataFallbackUrl: 'https://analytics.app.veridian.site/42' },
      { env },
    );
    expect(r).toMatchObject({ url: 'https://analytics.app.veridian.site/42', source: 'metadata' });
  });
});
