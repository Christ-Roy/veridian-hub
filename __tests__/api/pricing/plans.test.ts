/**
 * Tests app/api/pricing/plans/route.ts
 *
 * Contrat consommé par Notifuse Go (et futurs clients HTTP non-TS).
 * NE PAS modifier la shape JSON sans coordination avec les apps qui le lisent.
 */
import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/pricing/plans/route';

describe('GET /api/pricing/plans', () => {
  it('retourne 200 + JSON avec plans/refill/annual_perks/version', async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      plans: expect.any(Object),
      refill: {
        pricing_cents: expect.any(Object),
        max_per_order: expect.any(Number),
      },
      annual_perks: expect.objectContaining({
        supportPriority: true,
        premiumTutos: true,
        annualDiscountPct: 17,
      }),
      version: expect.any(String),
      generated_at: expect.any(String),
    });
  });

  it('expose les 11 plans canoniques (clés stables pour Notifuse)', async () => {
    const res = await GET();
    const body = await res.json();
    const keys = Object.keys(body.plans).sort();
    expect(keys).toEqual([
      'internal',
      'lifetime-partner',
      'lifetime-site-vitrine',
      'notifuse-business',
      'notifuse-free',
      'notifuse-pro',
      'prospection-business',
      'prospection-free',
      'prospection-pro',
      'veridian-business',
      'veridian-pro',
    ]);
  });

  it('refill.pricing_cents.business retourne 5 tranches', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.refill.pricing_cents.business).toHaveLength(5);
    expect(body.refill.max_per_order).toBe(100_000);
  });

  it('cache-control 1h + stale-while-revalidate', async () => {
    const res = await GET();
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('max-age=3600');
    expect(cc).toContain('stale-while-revalidate');
  });

  it('generated_at est un ISO timestamp valide', async () => {
    const res = await GET();
    const body = await res.json();
    expect(() => new Date(body.generated_at)).not.toThrow();
    expect(new Date(body.generated_at).toString()).not.toBe('Invalid Date');
  });

  it('chaque plan expose id + price_eur + apps_unlocked (contrat consommateurs)', async () => {
    const res = await GET();
    const body = await res.json();
    for (const plan of Object.values(body.plans) as Array<Record<string, unknown>>) {
      expect(plan.id).toBeTruthy();
      expect(typeof plan.price_eur).toBe('number');
      expect(Array.isArray(plan.apps_unlocked)).toBe(true);
    }
  });
});
