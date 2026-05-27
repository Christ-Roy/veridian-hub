/**
 * RTL tests pour <CrmUsageCard /> — progress bar quota IA CRM.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CrmUsageCard } from '@/app/dashboard/crm/CrmUsageCard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('<CrmUsageCard>', () => {
  it('rend la conso formatée en millions + pourcentage', () => {
    render(
      <CrmUsageCard
        usage={{ used: 750_000, limit: 1_500_000, packCta: null }}
      />,
    );
    expect(screen.getByText(/750k\s*\/\s*1\.5M/i)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('quota dépassé : affiche CTA pack +5M', () => {
    render(
      <CrmUsageCard
        usage={{
          used: 1_600_000,
          limit: 1_500_000,
          packCta: { label: 'Acheter pack +5M tokens (30€)', href: '/x' },
        }}
      />,
    );
    expect(screen.getByText('100%')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /pack \+5M tokens/i });
    expect(cta).toHaveAttribute('href', '/x');
  });

  it('moins de 80% : pas de CTA pack même si dispo', () => {
    render(
      <CrmUsageCard
        usage={{
          used: 100_000,
          limit: 10_000_000,
          packCta: { label: 'pack', href: '/x' },
        }}
      />,
    );
    expect(screen.queryByRole('link', { name: /pack/i })).not.toBeInTheDocument();
  });

  it('packCta=null : pas de bouton même si dépassé', () => {
    render(
      <CrmUsageCard
        usage={{ used: 2_000_000, limit: 1_500_000, packCta: null }}
      />,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
