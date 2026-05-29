/**
 * Tests RTL pour `<EmptyBillingState />` — état vide de la page billing.
 * Vérifie que l'absence de subscription débouche sur un bloc actionnable
 * (CTA bouton vers /pricing) et non sur un lien texte nu.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyBillingState } from '@/app/dashboard/billing/EmptyBillingState';

describe('<EmptyBillingState>', () => {
  it('affiche un message d’accroche', () => {
    render(<EmptyBillingState />);
    expect(screen.getByText(/aucun abonnement actif/i)).toBeInTheDocument();
    expect(screen.getByText(/sans engagement/i)).toBeInTheDocument();
  });

  it('expose un CTA bouton vers la landing pricing (veridian.site/plateforme, pas un lien texte nu)', () => {
    // Refonte DA 2026-05-29 : pricing centralisé sur veridian.site/plateforme.
    render(<EmptyBillingState />);
    const cta = screen.getByRole('link', { name: /découvrir les formules/i });
    expect(cta).toHaveAttribute('href', 'https://veridian.site/plateforme');
  });
});
