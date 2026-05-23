/**
 * Tests RTL pour `<ShadowAppCard />` — card "shadow marketing" des apps
 * client_only (Analytics, CMS) affichée quand le tenant n'a pas de plan
 * lifetime_site_vitrine.
 *
 * Vérifie :
 *   - rendu de la card (nom + tagline de l'app)
 *   - le Dialog shadcn est fermé au montage
 *   - un click sur la card ouvre le Dialog explicatif
 *   - le bouton "Fermer" referme le Dialog
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ShadowAppCard } from '@/app/dashboard/components/ShadowAppCard';
import type { AppMetadata } from '@/lib/pricing/plans';

const ANALYTICS_APP: AppMetadata = {
  key: 'analytics',
  display_name: 'Veridian Analytics',
  self_serve: false,
  client_only: true,
  tagline: 'Dashboard multi-tenant',
  icon: '📊',
  marketing_url: 'https://veridian.site',
};

describe('<ShadowAppCard>', () => {
  it('exporte un composant React', () => {
    expect(typeof ShadowAppCard).toBe('function');
    expect(ShadowAppCard.name).toBe('ShadowAppCard');
  });

  it('affiche le nom et la tagline de l\'app', () => {
    render(<ShadowAppCard app={ANALYTICS_APP} />);

    expect(screen.getByText('Veridian Analytics')).toBeInTheDocument();
    expect(screen.getByText('Dashboard multi-tenant')).toBeInTheDocument();
  });

  it('le Dialog est fermé au montage', () => {
    render(<ShadowAppCard app={ANALYTICS_APP} />);

    // Le Dialog shadcn ne monte son contenu que lorsqu'il est ouvert.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('un click sur la card ouvre le Dialog explicatif', () => {
    render(<ShadowAppCard app={ANALYTICS_APP} />);

    fireEvent.click(screen.getByText('Découvrir les sites Veridian'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /incluse avec l'achat d'un site vitrine Veridian/i,
      ),
    ).toBeInTheDocument();
  });

  it('le bouton "Fermer" referme le Dialog', () => {
    render(<ShadowAppCard app={ANALYTICS_APP} />);

    fireEvent.click(screen.getByText('Découvrir les sites Veridian'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
