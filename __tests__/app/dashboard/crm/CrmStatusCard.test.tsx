/**
 * RTL tests pour <CrmStatusCard /> — couvre les 3 variantes UI (mode
 * plan-agnostic, revert Robert 2026-05-27) :
 *  - inactive : pas de tenant, CTA "Activer mon CRM"
 *  - loading  : tenant en cours de provisionnement, bouton disabled
 *  - active   : tenant actif, CTA "Ouvrir mon CRM" (magic-link)
 *
 * On ne teste pas les fetch ici (couvert côté route + E2E), juste le rendu
 * et la présence/état des CTA principaux pour chaque variante.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CrmStatusCard } from '@/app/dashboard/crm/CrmStatusCard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('<CrmStatusCard>', () => {
  it('inactive : CTA "Activer mon CRM" enabled, pas de plan-gating', () => {
    render(<CrmStatusCard variant={{ kind: 'inactive' }} />);
    expect(screen.getByText(/Active ton CRM Veridian/i)).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /activer mon crm/i });
    expect(cta).toBeEnabled();
    // Garde-fou anti-régression : pas de mention de plan ou de pricing
    // dans la card inactive (Q1 pas tranché).
    expect(screen.queryByText(/à partir du plan/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/upgrader/i)).not.toBeInTheDocument();
  });

  it('loading : badge "Provisionnement…" + bouton disabled', () => {
    render(<CrmStatusCard variant={{ kind: 'loading' }} />);
    expect(
      screen.getByText(/CRM en cours de provisionnement/i),
    ).toBeInTheDocument();
    const badges = screen.getAllByText(/Provisionnement…/i);
    expect(badges.length).toBeGreaterThanOrEqual(1);
    const btn = screen.getByRole('button', { name: /provisionnement/i });
    expect(btn).toBeDisabled();
  });

  it('active : badge "CRM actif" + CTA "Ouvrir mon CRM" enabled', () => {
    render(
      <CrmStatusCard variant={{ kind: 'active', status: 'active' }} />,
    );
    expect(screen.getByText(/Mon CRM Veridian/i)).toBeInTheDocument();
    expect(screen.getByText('CRM actif')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /ouvrir mon crm/i });
    expect(cta).toBeEnabled();
  });

  it('active status=suspended : badge destructive + bouton disabled', () => {
    render(
      <CrmStatusCard variant={{ kind: 'active', status: 'suspended' }} />,
    );
    expect(screen.getByText('Suspendu')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ouvrir mon crm/i }),
    ).toBeDisabled();
  });

  it('active status=error : badge erreur + bouton disabled', () => {
    render(
      <CrmStatusCard variant={{ kind: 'active', status: 'error' }} />,
    );
    expect(screen.getByText('Erreur')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ouvrir mon crm/i }),
    ).toBeDisabled();
  });
});
