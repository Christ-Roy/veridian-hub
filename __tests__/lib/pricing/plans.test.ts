/**
 * Test du catalogue lib/pricing/plans.ts — vérifie les invariants gravés
 * dans CONTRAT-HUB.md §3 (Plans Veridian — matrice cross-app).
 */

import { describe, it, expect } from 'vitest';
import {
  PLANS,
  PUBLIC_PLANS,
  PAYABLE_PLANS,
  MANUAL_PLANS,
  type PlanKey,
} from '@/lib/pricing/plans';

describe('PLANS catalogue', () => {
  it('contient les 11 plans attendus', () => {
    const keys = Object.keys(PLANS).sort();
    expect(keys).toEqual([
      'internal',
      'lifetime-partner',
      'lifetime-site-vitrine',
      'notifuse-business',
      'notifuse-free',
      'notifuse-pro',
      'prospection-enterprise',
      'prospection-free',
      'prospection-pro',
      'veridian-business',
      'veridian-pro',
    ]);
  });

  it('chaque plan a sa clé qui matche son key field', () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.key).toBe(key);
    }
  });

  it('CONTRAT §3.3 : les 3 plans offerts cross-app sont présents', () => {
    const required: PlanKey[] = ['lifetime-site-vitrine', 'lifetime-partner', 'internal'];
    for (const k of required) {
      expect(PLANS[k]).toBeDefined();
      expect(PLANS[k].plan_source).not.toBe('stripe');
      expect(PLANS[k].price_eur).toBe(0);
      expect(PLANS[k].hidden_from_public).toBe(true);
    }
  });

  it('CONTRAT §3.3 : plans offerts ont rank 99 (immunes au comparePlanRank Stripe)', () => {
    expect(PLANS['lifetime-site-vitrine'].rank).toBe(99);
    expect(PLANS['lifetime-partner'].rank).toBe(99);
    expect(PLANS['internal'].rank).toBe(99);
  });

  it('CONTRAT §3.2 : chaque app a un plan free obligatoire', () => {
    expect(PLANS['notifuse-free'].price_eur).toBe(0);
    expect(PLANS['prospection-free'].price_eur).toBe(0);
  });

  it('CONTRAT §3.2 : max 4 plans payants/freemium par app', () => {
    const notifusePlans = Object.values(PLANS).filter(
      (p) => p.apps.length === 1 && p.apps[0] === 'notifuse' && p.plan_source === 'stripe',
    );
    const prospectionPlans = Object.values(PLANS).filter(
      (p) => p.apps.length === 1 && p.apps[0] === 'prospection' && p.plan_source === 'stripe',
    );
    expect(notifusePlans.length).toBeLessThanOrEqual(4);
    expect(prospectionPlans.length).toBeLessThanOrEqual(4);
  });

  it('bundles débloquent les 2 apps simultanément', () => {
    expect(PLANS['veridian-pro'].apps.sort()).toEqual(['notifuse', 'prospection']);
    expect(PLANS['veridian-business'].apps.sort()).toEqual(['notifuse', 'prospection']);
  });

  it('bundle "veridian-pro" est marqué recommended', () => {
    expect(PLANS['veridian-pro'].recommended).toBe(true);
  });

  it("bundles ont un prix dégressif vs cumul à la carte", () => {
    const proCumul = PLANS['notifuse-pro'].price_eur + PLANS['prospection-pro'].price_eur;
    expect(PLANS['veridian-pro'].price_eur).toBeLessThan(proCumul);
  });

  it('PUBLIC_PLANS exclut les plans offerts', () => {
    expect(PUBLIC_PLANS).not.toContain('lifetime-site-vitrine');
    expect(PUBLIC_PLANS).not.toContain('lifetime-partner');
    expect(PUBLIC_PLANS).not.toContain('internal');
  });

  it('PAYABLE_PLANS exclut les free + les offerts', () => {
    expect(PAYABLE_PLANS).not.toContain('notifuse-free');
    expect(PAYABLE_PLANS).not.toContain('prospection-free');
    expect(PAYABLE_PLANS).not.toContain('lifetime-site-vitrine');
  });

  it('MANUAL_PLANS contient exactement les plans offerts', () => {
    expect(MANUAL_PLANS.sort()).toEqual(['internal', 'lifetime-partner', 'lifetime-site-vitrine']);
  });

  it('chaque plan a son plan_source valide', () => {
    const valid = ['stripe', 'manual', 'lifetime_site_vitrine', 'lifetime_partner', 'internal'];
    for (const plan of Object.values(PLANS)) {
      expect(valid).toContain(plan.plan_source);
    }
  });
});
