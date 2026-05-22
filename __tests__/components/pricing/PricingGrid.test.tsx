/**
 * Tests PricingGrid — rendu de la grille tarifaire et structure post-refacto.
 *
 * Refacto Lot D : les couleurs hardcodées du PlanCard ont été remplacées par
 * des tokens OKLCH (badge "Recommandé" `bg-indigo-600` -> Badge variant default
 * = `bg-primary` ; ring `ring-indigo-500` -> `ring-primary` ; `text-green-600`
 * -> `text-success`). Ces tests verrouillent que la grille rend bien sa
 * structure ET que le badge mis en avant utilise le token primary, pas une
 * couleur Tailwind brute — c'est la régression que le refacto doit empêcher.
 *
 * Les fixtures Plan sont fabriquées localement (pas dérivées de PLANS réels)
 * pour rester stables si la grille de prix bouge — on teste le composant, pas
 * la config pricing.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PricingGrid } from '@/components/pricing/PricingGrid';
import type { Plan } from '@/lib/pricing/plans';

/** Fabrique un Plan minimal mais complet pour le rendu. */
function makePlan(overrides: Partial<Plan> & Pick<Plan, 'key' | 'name'>): Plan {
  return {
    tagline: 'Plan de test',
    price_eur: 0,
    price_eur_yearly_per_month: null,
    stripePriceId: { month: null, year: null },
    stripePriceIdTest: { month: null, year: null },
    apps: ['notifuse'],
    members_seats: 'unlimited',
    quotas: { notifuse: { emails_per_month: 'unlimited', members_max: 'unlimited' } },
    features: [
      { label: 'Feature incluse', included: true },
      { label: 'Feature absente', included: false },
    ],
    rank: 1,
    plan_source: 'stripe',
    ...overrides,
  };
}

describe('PricingGrid (smoke)', () => {
  it('exporte un composant React', () => {
    expect(typeof PricingGrid).toBe('function');
    expect(PricingGrid.name).toBe('PricingGrid');
  });
});

describe('PricingGrid (rendu)', () => {
  const notifusePlans: Plan[] = [
    makePlan({ key: 'notifuse-free', name: 'Notifuse Free', price_eur: 0 }),
    makePlan({
      key: 'notifuse-pro',
      name: 'Notifuse Pro',
      price_eur: 29,
      price_eur_yearly_per_month: 24,
      recommended: true,
    }),
  ];

  function renderGrid() {
    return render(
      <PricingGrid
        bundles={[]}
        notifuse={notifusePlans}
        prospection={[]}
        isAuthenticated={false}
      />
    );
  }

  it('rend le titre de la grille et le switch mensuel / annuel', () => {
    renderGrid();
    expect(screen.getByRole('heading', { name: /Tarifs Veridian/i, level: 1 })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Mensuel$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Annuel/i })).toBeTruthy();
  });

  it('le bouton Annuel affiche l\'argument de réduction -17%', () => {
    // Le toggle annuel porte un libellé "-17%" pour matérialiser l'économie
    // du paiement annuel. Verrouille ce wording — c'est un argument de
    // conversion, pas un détail cosmétique.
    renderGrid();
    const annuel = screen.getByRole('button', { name: /Annuel/i });
    expect(annuel.textContent).toMatch(/-17\s*%/);
  });

  it('bascule l\'affichage du prix mensuel ↔ annuel au clic sur le toggle', () => {
    // Notifuse Pro : 29€/mois, 24€/mois facturé annuellement. Le clic sur
    // "Annuel" doit faire apparaître le prix annuel, le retour "Mensuel"
    // le prix mensuel — c'est la logique métier du toggle.
    renderGrid();
    // Au montage : intervalle mensuel → 29€ visible.
    expect(screen.getByText('29€')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Annuel/i }));
    expect(screen.getByText('24€')).toBeTruthy();
    expect(screen.getByText(/facturé annuellement/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Mensuel$/i }));
    expect(screen.getByText('29€')).toBeTruthy();
  });

  it('rend une carte par plan fourni', () => {
    renderGrid();
    expect(screen.getByText('Notifuse Free')).toBeTruthy();
    expect(screen.getByText('Notifuse Pro')).toBeTruthy();
  });

  it('affiche le badge "Recommandé" avec le token primary (pas bg-indigo-600)', () => {
    renderGrid();
    const badge = screen.getByText('Recommandé');
    // Le refacto Lot D a remplacé bg-indigo-600 par Badge variant default.
    expect(badge.className).toContain('bg-primary');
    expect(badge.className).not.toMatch(/bg-indigo/);
    expect(badge.className).not.toMatch(/text-white/);
  });

  it('le PlanCard recommandé porte un ring token (ring-primary, pas ring-indigo)', () => {
    const { container } = renderGrid();
    const ringed = container.querySelector('.ring-primary');
    expect(ringed).not.toBeNull();
    expect(container.querySelector('.ring-indigo-500')).toBeNull();
  });

  it('rend un CTA gratuit "Démarrer gratuitement" pour un plan à 0€', () => {
    renderGrid();
    expect(screen.getByRole('button', { name: /Démarrer gratuitement/i })).toBeTruthy();
  });
});
