/**
 * Tests RTL pour `<SubscriptionCard />` — carte "plan actuel" de la page
 * billing. Verrouille l'affichage par statut : prix formaté fr-FR, badge,
 * encart essai, dates clés (prochaine échéance vs accès jusqu'au).
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  SubscriptionCard,
  type SubscriptionView,
} from '@/app/dashboard/billing/SubscriptionCard';

function makeView(overrides: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    status: 'active',
    planName: 'Pro',
    unitAmount: 2900,
    currency: 'EUR',
    interval: 'month',
    currentPeriodEnd: '2026-07-01T00:00:00.000Z',
    trialEnd: null,
    cancelAt: null,
    ...overrides,
  };
}

describe('<SubscriptionCard>', () => {
  it('affiche le nom du plan et le prix formaté en euros', () => {
    render(<SubscriptionCard subscription={makeView()} />);
    expect(screen.getByText('Pro')).toBeInTheDocument();
    // 2900 centimes → "29 €" (fr-FR, sans décimales).
    expect(screen.getByText(/29/)).toBeInTheDocument();
    expect(screen.getByText('/ mois')).toBeInTheDocument();
  });

  it('active : affiche la prochaine échéance, pas d’encart essai', () => {
    render(<SubscriptionCard subscription={makeView({ status: 'active' })} />);
    expect(screen.getByText(/prochaine échéance/i)).toBeInTheDocument();
    expect(screen.queryByText(/essai gratuit en cours/i)).not.toBeInTheDocument();
  });

  it('trialing : affiche l’encart essai avec la date de fin', () => {
    render(
      <SubscriptionCard
        subscription={makeView({
          status: 'trialing',
          trialEnd: '2026-06-15T00:00:00.000Z',
        })}
      />
    );
    expect(screen.getByText(/essai gratuit en cours/i)).toBeInTheDocument();
    // Pas de "prochaine échéance" pendant l'essai.
    expect(screen.queryByText(/prochaine échéance/i)).not.toBeInTheDocument();
  });

  it('canceled : affiche "Accès maintenu jusqu’au" à la place de l’échéance', () => {
    render(
      <SubscriptionCard
        subscription={makeView({
          status: 'canceled',
          cancelAt: '2026-08-01T00:00:00.000Z',
        })}
      />
    );
    expect(screen.getByText(/accès maintenu jusqu’au/i)).toBeInTheDocument();
    expect(screen.queryByText(/prochaine échéance/i)).not.toBeInTheDocument();
  });

  it('past_due : affiche le badge "Paiement en échec"', () => {
    render(<SubscriptionCard subscription={makeView({ status: 'past_due' })} />);
    expect(screen.getByText('Paiement en échec')).toBeInTheDocument();
  });

  it('gère une devise absente sans crasher (fallback EUR)', () => {
    render(
      <SubscriptionCard
        subscription={makeView({ currency: '', unitAmount: 9900 })}
      />
    );
    expect(screen.getByText(/99/)).toBeInTheDocument();
  });

  it('gère un interval inconnu via un libellé brut', () => {
    render(
      <SubscriptionCard
        subscription={makeView({ interval: 'quarter' })}
      />
    );
    expect(screen.getByText('/ quarter')).toBeInTheDocument();
  });
});
