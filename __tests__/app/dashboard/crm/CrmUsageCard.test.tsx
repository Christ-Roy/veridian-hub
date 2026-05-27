/**
 * RTL tests pour <CrmUsageCard /> — progress bar quota IA CRM.
 *
 * Mode plan-agnostic (revert Robert 2026-05-27) : la card sait juste
 * afficher un ratio used/limit + un badge "Aperçu" si mock=true. Les
 * limites par plan et le pack +5M tokens reviendront quand la grille
 * business sera figée.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CrmUsageCard } from '@/app/dashboard/crm/CrmUsageCard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('<CrmUsageCard>', () => {
  it('rend la conso formatée + pourcentage + progressbar aria', () => {
    render(
      <CrmUsageCard usage={{ used: 750_000, limit: 1_500_000 }} />,
    );
    expect(screen.getByText(/750k\s*\/\s*1\.5M/i)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('mock=true : affiche badge "Aperçu" + copy disclaimer', () => {
    render(
      <CrmUsageCard
        usage={{ used: 0, limit: 1_000_000, mock: true }}
      />,
    );
    expect(screen.getByText('Aperçu')).toBeInTheDocument();
    expect(screen.getByText(/aperçu visuel/i)).toBeInTheDocument();
  });

  it('mock absent : pas de badge "Aperçu", copy normale', () => {
    render(
      <CrmUsageCard usage={{ used: 100_000, limit: 1_000_000 }} />,
    );
    expect(screen.queryByText('Aperçu')).not.toBeInTheDocument();
    expect(screen.getByText(/Tokens consommés/i)).toBeInTheDocument();
  });

  it('cap à 100% quand used > limit (anti-affichage 142%)', () => {
    render(
      <CrmUsageCard usage={{ used: 2_000_000, limit: 1_500_000 }} />,
    );
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
