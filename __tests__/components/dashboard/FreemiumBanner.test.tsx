/**
 * Tests FreemiumBanner — bandeau trial du dashboard.
 *
 * Vérifie la conformité à `docs/PRICING-VERIDIAN.md` §"Interdits côté code" :
 *   - aucun compteur visible "X jours restants"
 *   - aucune barre de progression
 *   - bandeau masqué tant qu'aucune phase n'est passée (phases silencieuses)
 *
 * Le composant est purement présentationnel : il reçoit une `phase` déjà
 * résolue côté serveur, il ne calcule plus aucune date.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FreemiumBanner } from '@/components/dashboard/FreemiumBanner';

describe('FreemiumBanner — phases silencieuses (rien à afficher)', () => {
  it('phase absente → ne rend rien', () => {
    const { container } = render(<FreemiumBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('phase null → ne rend rien', () => {
    const { container } = render(<FreemiumBanner phase={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('FreemiumBanner — phase active (trial révélé)', () => {
  it('affiche un message sobre "essai gratuit"', () => {
    render(<FreemiumBanner phase="active" />);
    expect(screen.getByText(/essai gratuit/i)).toBeInTheDocument();
  });

  it('a un CTA vers les formules', () => {
    render(<FreemiumBanner phase="active" />);
    const cta = screen.getByRole('link', { name: /formules/i });
    expect(cta).toHaveAttribute('href', '/pricing');
  });
});

describe('FreemiumBanner — phase ending_soon', () => {
  it('dit ce qui arrive vraiment : retour au plan gratuit, rien de bloqué', () => {
    render(<FreemiumBanner phase="ending_soon" />);
    expect(screen.getByText(/plan gratuit, sans rien bloquer/i)).toBeInTheDocument();
  });

  it('CTA "Garder le plan Pro" pointe vers le billing', () => {
    render(<FreemiumBanner phase="ending_soon" />);
    const cta = screen.getByRole('link', { name: /garder le plan pro/i });
    expect(cta).toHaveAttribute('href', '/dashboard/billing');
  });
});

describe('FreemiumBanner — phase expired (paywall)', () => {
  it('indique que l\'essai est terminé', () => {
    render(<FreemiumBanner phase="expired" />);
    expect(screen.getByText(/essai Pro est terminé : votre espace est revenu au plan gratuit/i)).toBeInTheDocument();
  });

  it('a un CTA vers les formules', () => {
    render(<FreemiumBanner phase="expired" />);
    expect(
      screen.getByRole('link', { name: /voir les formules/i }),
    ).toBeInTheDocument();
  });
});

describe('FreemiumBanner — interdits PRICING-VERIDIAN.md', () => {
  it('n\'affiche AUCUN compteur "jours restants" en phase active', () => {
    render(<FreemiumBanner phase="active" />);
    expect(screen.queryByText(/jours? restants?/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+\s*h restantes/i)).not.toBeInTheDocument();
  });

  it('n\'affiche aucune barre de progression', () => {
    const { container } = render(<FreemiumBanner phase="active" />);
    // L'ancienne barre était un <div> avec width inline en %. On vérifie
    // qu'aucun élément ne porte un style width: %.
    const withInlineWidth = container.querySelectorAll('[style*="width"]');
    expect(withInlineWidth.length).toBe(0);
  });

  it('a un bouton de fermeture accessible', () => {
    render(<FreemiumBanner phase="active" />);
    expect(
      screen.getByRole('button', { name: /fermer le bandeau/i }),
    ).toBeInTheDocument();
  });
});
