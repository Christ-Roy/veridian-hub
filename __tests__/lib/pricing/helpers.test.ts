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
import { PLANS } from '@/lib/pricing/plans';

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

  // Roundtrip : si le catalogue a un Price ID rempli (post setup-stripe-prices),
  // le resolver doit retrouver UN plan qui porte ce Price ID. On ne teste pas
  // l'égalité stricte de clé : `prospection-enterprise` est un alias legacy de
  // `prospection-business` et partage le même stripePriceId — un price donné
  // peut donc résoudre vers l'un ou l'autre. L'invariant correct : le plan
  // résolu porte bien ce price ID. Robuste que les IDs soient remplis ou non.
  it('roundtrip : un Price ID du catalogue résout vers un plan portant ce Price ID', () => {
    for (const plan of Object.values(PLANS)) {
      for (const interval of ['month', 'year'] as const) {
        const id = plan.stripePriceId[interval];
        if (!id) continue;
        const resolved = getPlanByStripePriceId(id);
        expect(resolved).not.toBeNull();
        // Le plan résolu doit porter ce Price ID (sur month ou year).
        const resolvedIds = [
          resolved!.stripePriceId.month,
          resolved!.stripePriceId.year,
        ];
        expect(resolvedIds).toContain(id);
      }
    }
  });

  it('résout aussi les Price IDs TEST (webhook staging)', () => {
    // Le webhook Stripe peut tourner en staging avec un Price ID TEST —
    // le resolver doit couvrir les deux jeux, pas seulement Live.
    for (const plan of Object.values(PLANS)) {
      for (const interval of ['month', 'year'] as const) {
        const testId = plan.stripePriceIdTest[interval];
        if (!testId) continue;
        const resolved = getPlanByStripePriceId(testId);
        expect(resolved).not.toBeNull();
        const resolvedTestIds = [
          resolved!.stripePriceIdTest.month,
          resolved!.stripePriceIdTest.year,
        ];
        expect(resolvedTestIds).toContain(testId);
      }
    }
  });

  // ─── LEGACY_STRIPE_PRICE_MAPPING (cf plans.ts + CONTRAT-BILLING §3.7) ────
  // Les subs Stripe LIVE souscrites avant le pivot catalogue v3 (2026-05-22)
  // référencent des Price IDs qui n'existent plus au catalogue actuel. Le
  // mapping legacy doit les résoudre en fallback pour ne pas warner ni
  // perdre la propagation downstream.
  it('LEGACY : résout price_1SvGFY... (Pro v2 29€) vers veridian-pro', () => {
    // Sub legacy sub_1TUtgWRgvfRggzUNC5OjqiuU (past_due, cus_UTrPVfNjDmFie5)
    // détectée au 2026-05-22 — composant principal "Pro" 29€/mois.
    const resolved = getPlanByStripePriceId('price_1SvGFYRgvfRggzUNMoGboHCU');
    expect(resolved).not.toBeNull();
    expect(resolved!.key).toBe('veridian-pro');
  });

  it('LEGACY : résout price_1SyXiR... (workflow credits add-on) vers veridian-pro', () => {
    // Second item de la même sub legacy — add-on metered usage-based
    // (workflow credits) qui voyage avec le Pro. Mappé sur la même PlanKey
    // que le composant principal pour ne pas warner.
    const resolved = getPlanByStripePriceId('price_1SyXiRRgvfRggzUNDEr7BkUj');
    expect(resolved).not.toBeNull();
    expect(resolved!.key).toBe('veridian-pro');
  });

  it('LEGACY : un Price ID inconnu reste null (pas de fuite du mapping)', () => {
    // Garde-fou contre une catch-all qui transformerait tout Price ID en
    // veridian-pro. Le mapping doit rester strict : entrée explicite ou null.
    expect(getPlanByStripePriceId('price_jamais_emis_par_veridian')).toBeNull();
  });

  it('LEGACY : le catalogue canonique prime sur le mapping legacy', () => {
    // Si jamais un Price ID du catalogue actuel apparaît aussi dans le
    // mapping legacy (cas pathologique d'oubli de nettoyage), la résolution
    // doit pointer vers le plan canonique, pas vers l'entrée legacy.
    // On vérifie l'ordre : le for-loop catalogue précède le lookup legacy
    // dans getPlanByStripePriceId.
    for (const plan of Object.values(PLANS)) {
      const liveMonth = plan.stripePriceId.month;
      if (!liveMonth) continue;
      const resolved = getPlanByStripePriceId(liveMonth);
      expect(resolved).not.toBeNull();
      // Le résolu porte ce Price ID dans son champ canonique (Live ou Test)
      const ids = [
        resolved!.stripePriceId.month,
        resolved!.stripePriceId.year,
        resolved!.stripePriceIdTest.month,
        resolved!.stripePriceIdTest.year,
      ];
      expect(ids).toContain(liveMonth);
      break; // une itération suffit pour valider l'ordre
    }
  });
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
  // Les plans free n'ont JAMAIS de Stripe Price ID (pas de checkout) — le
  // throw est testable dessus sans dépendre de l'état de provisioning des
  // plans payants (dont les IDs se remplissent après setup-stripe-prices).
  it('throw si le plan n_a pas de Stripe Price ID (plan free)', () => {
    expect(() => getStripePriceIdForCheckout('notifuse-free', 'month')).toThrow(
      /no Stripe Price ID/,
    );
  });

  it('hors prod : résout vers le Price ID TEST du plan payant', () => {
    // En environnement de test vitest, isProduction()=false (pas de DOMAIN
    // app.veridian.site) → le helper doit retourner le stripePriceIdTest.
    const testId = PLANS['notifuse-pro'].stripePriceIdTest.month;
    if (testId) {
      // Catalogue provisionné en TEST → le helper retourne l'ID Test.
      expect(getStripePriceIdForCheckout('notifuse-pro', 'month')).toBe(testId);
    } else {
      // Pas encore provisionné en TEST → throw attendu.
      expect(() => getStripePriceIdForCheckout('notifuse-pro', 'month')).toThrow(
        /Price ID Test/,
      );
    }
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
