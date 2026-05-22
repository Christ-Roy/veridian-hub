/**
 * Tests des fonctions pures de scripts/admin/setup-stripe-prices.ts.
 *
 * On teste le parser du catalogue (`extractPayablePlans`) et le ré-écriveur
 * de Price IDs (`patchPlanPriceIds`) sans toucher à Stripe. Le run réel
 * (`main()`) ne s'exécute pas à l'import (gardé par `require.main === module`).
 *
 * Ce qui est couvert :
 *   - extraction des 6 plans payants v1.1 avec montants corrects
 *   - exclusion des plans free et des plans offerts (lifetime/internal)
 *   - patch idempotent de stripePriceIdTest / stripePriceIdLive
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  extractPayablePlans,
  patchPlanPriceIds,
} from '@/scripts/admin/setup-stripe-prices';

const PLANS_FILE = join(
  __dirname,
  '..',
  '..',
  'shared',
  'shared',
  'pricing',
  'plans.ts',
);
const SOURCE = readFileSync(PLANS_FILE, 'utf8');

describe('extractPayablePlans', () => {
  const plans = extractPayablePlans(SOURCE);

  it('extrait exactement les 6 plans payants v1.1', () => {
    const keys = plans.map((p) => p.key).sort();
    expect(keys).toEqual([
      'notifuse-business',
      'notifuse-pro',
      'prospection-business',
      'prospection-pro',
      'veridian-business',
      'veridian-pro',
    ]);
  });

  it('exclut les plans free et les plans offerts', () => {
    const keys = plans.map((p) => p.key);
    expect(keys).not.toContain('notifuse-free');
    expect(keys).not.toContain('prospection-free');
    expect(keys).not.toContain('lifetime-site-vitrine');
    expect(keys).not.toContain('lifetime-partner');
    expect(keys).not.toContain('internal');
  });

  it('extrait les prix mensuels corrects (grille v1.1)', () => {
    const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));
    expect(byKey['notifuse-pro'].priceEurMonth).toBe(29);
    expect(byKey['notifuse-business'].priceEurMonth).toBe(99);
    expect(byKey['prospection-pro'].priceEurMonth).toBe(29);
    expect(byKey['prospection-business'].priceEurMonth).toBe(89);
    expect(byKey['veridian-pro'].priceEurMonth).toBe(49);
    expect(byKey['veridian-business'].priceEurMonth).toBe(149);
  });

  it('extrait les prix annuels/mois corrects', () => {
    const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));
    expect(byKey['notifuse-pro'].priceEurYearPerMonth).toBe(24);
    expect(byKey['veridian-business'].priceEurYearPerMonth).toBe(124);
  });

  it('extrait les apps débloquées (bundle = 2 apps)', () => {
    const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));
    expect(byKey['notifuse-pro'].apps).toEqual(['notifuse']);
    expect(byKey['veridian-pro'].apps.sort()).toEqual(['notifuse', 'prospection']);
  });
});

/**
 * Fixture de catalogue minimal et contrôlé — indépendante de l'état réel de
 * `plans.ts` (qui contient désormais les Price IDs du provisioning). Les
 * tests de patch raisonnent sur cette fixture, pas sur le fichier vivant.
 */
const FIXTURE_SOURCE = `export const PLANS = {
  'notifuse-pro': {
    id: 'notifuse-pro',
    name: 'Notifuse Pro',
    stripePriceIdLive: { month: null, year: null },
    stripePriceIdTest: { month: null, year: null },
    rank: 2,
  },

  'notifuse-business': {
    id: 'notifuse-business',
    name: 'Notifuse Business',
    stripePriceIdLive: { month: null, year: null },
    stripePriceIdTest: { month: null, year: null },
    rank: 3,
  },
};
`;

describe('patchPlanPriceIds', () => {
  it('remplit stripePriceIdTest avec month + year', () => {
    const patched = patchPlanPriceIds(FIXTURE_SOURCE, 'notifuse-pro', 'Test', {
      month: 'price_test_m',
      year: 'price_test_y',
    });
    const block = patched.slice(
      patched.indexOf("'notifuse-pro': {"),
      patched.indexOf("'notifuse-business': {"),
    );
    expect(block).toContain("stripePriceIdTest: { month: 'price_test_m', year: 'price_test_y' }");
  });

  it('remplit stripePriceIdLive sans toucher stripePriceIdTest', () => {
    const patched = patchPlanPriceIds(FIXTURE_SOURCE, 'notifuse-pro', 'Live', {
      month: 'price_live_m',
      year: 'price_live_y',
    });
    const block = patched.slice(
      patched.indexOf("'notifuse-pro': {"),
      patched.indexOf("'notifuse-business': {"),
    );
    expect(block).toContain("stripePriceIdLive: { month: 'price_live_m', year: 'price_live_y' }");
    // Un patch Live ne touche pas le champ Test (resté null dans la fixture).
    expect(block).toContain('stripePriceIdTest: { month: null, year: null }');
  });

  it('écrit null pour un year absent', () => {
    const patched = patchPlanPriceIds(FIXTURE_SOURCE, 'notifuse-pro', 'Test', {
      month: 'price_only_month',
      year: null,
    });
    const block = patched.slice(
      patched.indexOf("'notifuse-pro': {"),
      patched.indexOf("'notifuse-business': {"),
    );
    expect(block).toContain("stripePriceIdTest: { month: 'price_only_month', year: null }");
  });

  it('ne touche pas les autres plans', () => {
    const patched = patchPlanPriceIds(FIXTURE_SOURCE, 'notifuse-pro', 'Test', {
      month: 'price_x',
      year: 'price_y',
    });
    // notifuse-business garde son placeholder null (non ciblé par le patch).
    const block = patched.slice(patched.indexOf("'notifuse-business': {"));
    expect(block).toContain('stripePriceIdTest: { month: null, year: null }');
  });

  it('patch idempotent : re-patcher avec les mêmes IDs donne le même résultat', () => {
    const ids = { month: 'price_idem', year: 'price_idem_y' };
    const once = patchPlanPriceIds(SOURCE, 'veridian-pro', 'Live', ids);
    const twice = patchPlanPriceIds(once, 'veridian-pro', 'Live', ids);
    expect(twice).toBe(once);
  });
});
