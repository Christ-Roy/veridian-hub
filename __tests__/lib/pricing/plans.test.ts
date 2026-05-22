/**
 * Test du catalogue lib/pricing/plans.ts — vérifie les invariants gravés
 * dans CONTRAT-HUB.md §3 (Plans Veridian — matrice cross-app).
 */

import { describe, it, expect } from 'vitest';
import {
  PLANS,
  APPS,
  PUBLIC_PLANS,
  PAYABLE_PLANS,
  MANUAL_PLANS,
  type PlanKey,
} from '@/lib/pricing/plans';

describe('PLANS catalogue', () => {
  it('contient les 11 plans canoniques v1.1 + alias legacy prospection-enterprise', () => {
    const keys = Object.keys(PLANS).sort();
    expect(keys).toEqual([
      'internal',
      'lifetime-partner',
      'lifetime-site-vitrine',
      'notifuse-business',
      'notifuse-free',
      'notifuse-pro',
      'prospection-business', // canonique v1.1
      'prospection-enterprise', // alias LEGACY (= prospection-business)
      'prospection-free',
      'prospection-pro',
      'veridian-business',
      'veridian-pro',
    ]);
  });

  it('prospection-enterprise est un alias legacy de prospection-business', () => {
    expect(PLANS['prospection-enterprise'].price_eur).toBe(
      PLANS['prospection-business'].price_eur,
    );
    expect(PLANS['prospection-enterprise'].hidden_from_public).toBe(true);
    expect(PLANS['prospection-business'].hidden_from_public).toBe(false);
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

  // ─── v1.3 — members_seats cross-app ───

  it('CONTRAT §3.5 : chaque plan a un quota members_seats défini', () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.members_seats).toBeDefined();
    }
  });

  // PIVOT 2026-05-21 (v1.1) : générosité maximale.
  // Notifuse free/pro/business : seats illimités partout
  // Prospection : free=unlimited (growth hack), pro=5, business=25
  // Bundles : alignés Prospection (5/25)
  // Lifetime / internal : illimité ou aligné équivalent

  it('CONTRAT v1.1 §"SEULES différenciations" : Notifuse seats illimités sur tous tiers', () => {
    expect(PLANS['notifuse-free'].members_seats).toBe('unlimited');
    expect(PLANS['notifuse-pro'].members_seats).toBe('unlimited');
    expect(PLANS['notifuse-business'].members_seats).toBe('unlimited');
  });

  it('CONTRAT v1.1 §Prospection : free seats illimités (growth hack)', () => {
    expect(PLANS['prospection-free'].members_seats).toBe('unlimited');
  });

  it('CONTRAT v1.1 §Prospection : pro = 5 seats, business/enterprise = 25 seats', () => {
    expect(PLANS['prospection-pro'].members_seats).toBe(5);
    expect(PLANS['prospection-business'].members_seats).toBe(25);
    expect(PLANS['prospection-enterprise'].members_seats).toBe(25); // alias legacy
  });

  it('CONTRAT v1.1 §Bundles : Veridian Pro = 5 seats, Business = 25 seats (aligné Prosp)', () => {
    expect(PLANS['veridian-pro'].members_seats).toBe(5);
    expect(PLANS['veridian-business'].members_seats).toBe(25);
  });

  it('CONTRAT §3.3 : lifetime / internal = équivalents ou unlimited', () => {
    expect(PLANS['lifetime-site-vitrine'].members_seats).toBe(5);
    expect(PLANS['lifetime-partner'].members_seats).toBe(25);
    expect(PLANS['internal'].members_seats).toBe('unlimited');
  });
});

describe('stripePriceIdTest — mapping adaptateur canonical → Hub', () => {
  // adaptCanonicalToHub mappe désormais DEUX jeux de Stripe Price IDs :
  // stripePriceIdLive → Plan.stripePriceId (compte prod) et
  // stripePriceIdTest → Plan.stripePriceIdTest (compte test/preprod).
  // Ces tests verrouillent que le champ test est bien rempli et qu'il
  // n'est pas confondu avec le champ live.

  it('chaque plan expose un champ stripePriceIdTest avec les clés month/year', () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.stripePriceIdTest).toBeDefined();
      expect(plan.stripePriceIdTest).toHaveProperty('month');
      expect(plan.stripePriceIdTest).toHaveProperty('year');
    }
  });

  it('les plans payants ont des Stripe Price IDs TEST distincts des IDs LIVE', () => {
    // Garde-fou anti-confusion : si l'adaptateur recopiait stripePriceIdLive
    // dans stripePriceIdTest, le checkout en staging taperait le compte prod.
    // notifuse-pro a des IDs renseignés sur les 2 comptes — ils doivent différer.
    const proMonthTest = PLANS['notifuse-pro'].stripePriceIdTest.month;
    const proMonthLive = PLANS['notifuse-pro'].stripePriceId.month;
    expect(proMonthTest).toBeTruthy();
    expect(proMonthLive).toBeTruthy();
    expect(proMonthTest).not.toBe(proMonthLive);
  });

  it('les Stripe Price IDs TEST ont le préfixe price_ quand renseignés', () => {
    for (const plan of Object.values(PLANS)) {
      for (const id of [plan.stripePriceIdTest.month, plan.stripePriceIdTest.year]) {
        if (id !== null) {
          expect(id).toMatch(/^price_/);
        }
      }
    }
  });

  it('les plans gratuits ont stripePriceIdTest month/year à null', () => {
    // Un plan free n'a pas de Price Stripe — ni live ni test.
    expect(PLANS['notifuse-free'].stripePriceIdTest).toEqual({ month: null, year: null });
    expect(PLANS['prospection-free'].stripePriceIdTest).toEqual({ month: null, year: null });
  });
});

describe('APPS catalogue (v1.3)', () => {
  it('contient les 4 apps Veridian', () => {
    expect(Object.keys(APPS).sort()).toEqual(['analytics', 'cms', 'notifuse', 'prospection']);
  });

  it('CONTRAT §3.6 : Notifuse + Prospection = self_serve, pas client_only', () => {
    expect(APPS.notifuse.self_serve).toBe(true);
    expect(APPS.notifuse.client_only).toBe(false);
    expect(APPS.prospection.self_serve).toBe(true);
    expect(APPS.prospection.client_only).toBe(false);
  });

  it('CONTRAT §3.6 : Analytics + CMS = client_only (shadow marketing)', () => {
    expect(APPS.analytics.client_only).toBe(true);
    expect(APPS.analytics.self_serve).toBe(false);
    expect(APPS.cms.client_only).toBe(true);
    expect(APPS.cms.self_serve).toBe(false);
  });

  it('apps client_only ont une marketing_url définie pour CTA shadow', () => {
    expect(APPS.analytics.marketing_url).toBeTruthy();
    expect(APPS.cms.marketing_url).toBeTruthy();
  });

  it('marketing_url shadow pointe vers la racine veridian.site (pas /sites qui n_existe pas)', () => {
    expect(APPS.analytics.marketing_url).toBe('https://veridian.site');
    expect(APPS.cms.marketing_url).toBe('https://veridian.site');
  });

  it('chaque app a un display_name + tagline + icon', () => {
    for (const app of Object.values(APPS)) {
      expect(app.display_name).toBeTruthy();
      expect(app.tagline).toBeTruthy();
      expect(app.icon).toBeTruthy();
    }
  });
});
