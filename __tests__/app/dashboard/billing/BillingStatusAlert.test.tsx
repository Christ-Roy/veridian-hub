/**
 * Tests RTL pour `<BillingStatusAlert />` — bandeau de tête de page billing.
 * Vérifie qu'un user en échec de paiement ou annulé voit une alerte claire
 * + le bon CTA, et qu'aucun bandeau parasite n'apparaît sur un état sain.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// `StripePortalButton` (rendu pour le CTA past_due) importe une server action
// Stripe et `next/navigation` — on les neutralise pour un rendu RTL pur.
vi.mock('@/utils/stripe/server', () => ({
  createStripePortal: vi.fn().mockResolvedValue('https://billing.stripe.test'),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { BillingStatusAlert } from '@/app/dashboard/billing/BillingStatusAlert';

describe('<BillingStatusAlert>', () => {
  it('past_due : affiche une alerte d’urgence + CTA mise à jour carte', () => {
    render(<BillingStatusAlert status="past_due" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/dernier paiement a échoué/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /mettre à jour ma carte/i })
    ).toBeInTheDocument();
  });

  it('unpaid : traité comme past_due (CTA portal)', () => {
    render(<BillingStatusAlert status="unpaid" />);
    expect(
      screen.getByRole('button', { name: /mettre à jour ma carte/i })
    ).toBeInTheDocument();
  });

  it('canceled : affiche un CTA "Réactiver" pointant vers la landing pricing (veridian.site/plateforme)', () => {
    // Depuis la refonte DA 2026-05-29 : le Hub n'expose plus de page pricing
    // dans le tunnel ; le CTA renvoie vers la landing veridian.site/plateforme.
    render(<BillingStatusAlert status="canceled" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/abonnement est annulé/i)).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /réactiver mon abonnement/i });
    expect(cta).toHaveAttribute('href', 'https://veridian.site/plateforme');
  });

  it('incomplete_expired : traité comme une annulation', () => {
    render(<BillingStatusAlert status="incomplete_expired" />);
    expect(
      screen.getByRole('link', { name: /réactiver mon abonnement/i })
    ).toBeInTheDocument();
  });

  it('active : aucun bandeau', () => {
    const { container } = render(<BillingStatusAlert status="active" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('trialing : aucun bandeau', () => {
    const { container } = render(<BillingStatusAlert status="trialing" />);
    expect(container).toBeEmptyDOMElement();
  });
});
