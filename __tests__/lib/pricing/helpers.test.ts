/**
 * Test des helpers lib/pricing/helpers.ts — API d'accès au catalogue.
 */

import { describe, it, expect } from 'vitest';
import {
  getPlanByKey,
  tryGetPlanByKey,
  getPlanByStripePriceId,
  comparePlanRank,
  getStripePriceIdForCheckout,
  getPublicPricingSections,
  getAppPlansForBundle,
  buildCheckoutUrl,
} from '@/lib/pricing/helpers';

describe('getPlanByKey', () => {
  it('retourne le plan pour une clé valide', () => {
    const plan = getPlanByKey('notifuse-pro');
    expect(plan.key).toBe('notifuse-pro');
  });

  it('throw pour une clé inconnue', () => {
    // @ts-expect-error — test runtime error
    expect(() => getPlanByKey('unicorn')).toThrow(/Unknown plan key/);
  });
});

describe('tryGetPlanByKey', () => {
  it('retourne le plan pour une clé valide', () => {
    expect(tryGetPlanByKey('notifuse-pro')?.key).toBe('notifuse-pro');
  });

  it('retourne null pour string inconnue (pas throw)', () => {
    expect(tryGetPlanByKey('unicorn')).toBeNull();
    expect(tryGetPlanByKey('')).toBeNull();
  });
});

describe('getPlanByStripePriceId', () => {
  it('retourne null si stripe_price_id inconnu', () => {
    expect(getPlanByStripePriceId('price_unknown_123')).toBeNull();
  });

  // Note : les plans payants ont stripePriceId.month = null (placeholders TODO).
  // Ce test sera enrichi quand les vrais Stripe Price IDs seront ajoutés.
});

describe('comparePlanRank', () => {
  it('détecte un upgrade free → pro', () => {
    expect(comparePlanRank('notifuse-free', 'notifuse-pro')).toBe('upgrade');
  });

  it('détecte un downgrade pro → free', () => {
    expect(comparePlanRank('notifuse-pro', 'notifuse-free')).toBe('downgrade');
  });

  it('détecte égalité même plan', () => {
    expect(comparePlanRank('notifuse-pro', 'notifuse-pro')).toBe('same');
  });

  it('compare plans across apps via rank', () => {
    // veridian-pro et notifuse-pro ont le même rank (2) — sémantiquement
    // c'est cohérent (Pro de chaque côté), même si l'app diffère.
    expect(comparePlanRank('notifuse-pro', 'veridian-pro')).toBe('same');
  });
});

describe('getStripePriceIdForCheckout', () => {
  it('throw si le stripePriceId est placeholder (null)', () => {
    expect(() => getStripePriceIdForCheckout('notifuse-pro', 'month')).toThrow(
      /no Stripe Price ID/,
    );
  });
});

describe('getPublicPricingSections', () => {
  const sections = getPublicPricingSections();

  it('retourne 3 sections', () => {
    expect(sections).toHaveProperty('bundles');
    expect(sections).toHaveProperty('notifuse');
    expect(sections).toHaveProperty('prospection');
  });

  it('exclut tous les plans hidden_from_public', () => {
    const all = [...sections.bundles, ...sections.notifuse, ...sections.prospection];
    expect(all.every((p) => !p.hidden_from_public)).toBe(true);
  });

  it('bundles contient veridian-pro et veridian-business', () => {
    const keys = sections.bundles.map((p) => p.key).sort();
    expect(keys).toEqual(['veridian-business', 'veridian-pro']);
  });

  it('notifuse contient les 3 plans à la carte (free + pro + business)', () => {
    expect(sections.notifuse).toHaveLength(3);
  });

  it('prospection contient les 3 plans à la carte (free + pro + enterprise)', () => {
    expect(sections.prospection).toHaveLength(3);
  });

  it('chaque section est triée par rank croissant', () => {
    for (const section of Object.values(sections)) {
      const ranks = section.map((p) => p.rank);
      const sorted = [...ranks].sort((a, b) => a - b);
      expect(ranks).toEqual(sorted);
    }
  });
});

describe('getAppPlansForBundle', () => {
  it('un bundle veridian-pro → notifuse-pro + prospection-pro', () => {
    const result = getAppPlansForBundle('veridian-pro');
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.app === 'notifuse')?.plan).toBe('notifuse-pro');
    expect(result.find((r) => r.app === 'prospection')?.plan).toBe('prospection-pro');
  });

  it('un bundle veridian-business → notifuse-business + prospection-enterprise', () => {
    const result = getAppPlansForBundle('veridian-business');
    expect(result.find((r) => r.app === 'notifuse')?.plan).toBe('notifuse-business');
    expect(result.find((r) => r.app === 'prospection')?.plan).toBe('prospection-enterprise');
  });

  it('lifetime-site-vitrine → notifuse-pro + prospection-pro (équivalence Pro)', () => {
    const result = getAppPlansForBundle('lifetime-site-vitrine');
    expect(result.find((r) => r.app === 'notifuse')?.plan).toBe('notifuse-pro');
    expect(result.find((r) => r.app === 'prospection')?.plan).toBe('prospection-pro');
  });

  it('internal → équivalence Business sur les 2 apps', () => {
    const result = getAppPlansForBundle('internal');
    expect(result.find((r) => r.app === 'notifuse')?.plan).toBe('notifuse-business');
    expect(result.find((r) => r.app === 'prospection')?.plan).toBe('prospection-enterprise');
  });

  it('un plan à la carte ne retourne que son app', () => {
    const result = getAppPlansForBundle('notifuse-pro');
    expect(result).toHaveLength(1);
    expect(result[0].app).toBe('notifuse');
    expect(result[0].plan).toBe('notifuse-pro');
  });
});

describe('buildCheckoutUrl', () => {
  it('construit l\'URL avec plan + interval', () => {
    const url = buildCheckoutUrl('notifuse-pro', 'month');
    expect(url).toBe('/api/billing/checkout?plan=notifuse-pro&interval=month');
  });

  it('inclut le redirect si fourni', () => {
    const url = buildCheckoutUrl('veridian-pro', 'year', '/dashboard');
    expect(url).toContain('redirect=%2Fdashboard');
  });
});
