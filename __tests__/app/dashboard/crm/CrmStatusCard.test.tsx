/**
 * RTL tests pour <CrmStatusCard /> — couvre les 3 variantes UI :
 * gated (Free), inactive (Pro/Business sans tenant), active (avec tenant).
 *
 * On ne teste pas les fetch ici (couvert côté route + E2E), juste le rendu
 * et la présence des CTA principaux pour chaque état.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CrmStatusCard } from '@/app/dashboard/crm/CrmStatusCard';

// next/link consomme useRouter via NextNavigationContext — neutralisé pour RTL.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('<CrmStatusCard>', () => {
  it('gated : affiche CTA "Voir les offres" pointant vers /pricing', () => {
    render(<CrmStatusCard variant={{ kind: 'gated' }} />);
    expect(screen.getAllByText(/CRM Veridian/i).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/inclus à partir du plan Pro/i),
    ).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /voir les offres/i });
    expect(cta).toHaveAttribute('href', '/pricing');
  });

  it('inactive : affiche CTA "Activer mon CRM" + label du plan', () => {
    render(
      <CrmStatusCard
        variant={{ kind: 'inactive', planLabel: 'Veridian Pro' }}
      />,
    );
    expect(screen.getByText(/Active ton CRM Veridian/i)).toBeInTheDocument();
    expect(screen.getByText('Veridian Pro')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /activer mon crm/i }),
    ).toBeInTheDocument();
  });

  it('active : affiche statut + CTA "Ouvrir mon CRM"', () => {
    render(
      <CrmStatusCard
        variant={{
          kind: 'active',
          planLabel: 'Veridian Business',
          status: 'active',
        }}
      />,
    );
    expect(screen.getByText(/Mon CRM Veridian/i)).toBeInTheDocument();
    expect(screen.getByText('CRM actif')).toBeInTheDocument();
    expect(screen.getByText('Veridian Business')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: /ouvrir mon crm/i });
    expect(cta).toBeEnabled();
  });

  it('active mais status=provisioning : le bouton "Ouvrir" est disabled', () => {
    render(
      <CrmStatusCard
        variant={{
          kind: 'active',
          planLabel: 'Veridian Pro',
          status: 'provisioning',
        }}
      />,
    );
    expect(screen.getByText(/provisionnement/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ouvrir mon crm/i }),
    ).toBeDisabled();
  });

  it('active status=suspended : badge destructive + bouton disabled', () => {
    render(
      <CrmStatusCard
        variant={{
          kind: 'active',
          planLabel: 'Veridian Pro',
          status: 'suspended',
        }}
      />,
    );
    expect(screen.getByText('Suspendu')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /ouvrir mon crm/i }),
    ).toBeDisabled();
  });
});
