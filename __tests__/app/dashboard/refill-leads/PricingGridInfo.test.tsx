/**
 * Tests RTL pour `<PricingGridInfo />` — tableau lecture seule des paliers
 * tarifaires refill leads selon plan Prospection courant.
 *
 * Vérifie :
 *   - rend bien le bon nombre de paliers selon plan (freemium=3, pro=4, business=5)
 *   - formatting FR (espace insécable comme séparateur de milliers via Intl)
 *   - affichage "50 000+" pour la tranche infinie business
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PricingGridInfo } from '@/app/dashboard/refill-leads/PricingGridInfo';

describe('<PricingGridInfo>', () => {
  it('rend 3 paliers pour freemium', () => {
    const { container } = render(<PricingGridInfo plan="freemium" />);
    expect(container.querySelectorAll('li').length).toBe(3);
    expect(screen.getByText(/0,50\s*€\/lead/)).toBeInTheDocument();
    expect(screen.getByText(/0,40\s*€\/lead/)).toBeInTheDocument();
    expect(screen.getByText(/0,30\s*€\/lead/)).toBeInTheDocument();
  });

  it('rend 4 paliers pour pro', () => {
    const { container } = render(<PricingGridInfo plan="pro" />);
    expect(container.querySelectorAll('li').length).toBe(4);
    expect(screen.getByText(/0,12\s*€\/lead/)).toBeInTheDocument();
  });

  it('rend 5 paliers pour business avec tranche infinie 50000+', () => {
    const { container } = render(<PricingGridInfo plan="business" />);
    expect(container.querySelectorAll('li').length).toBe(5);
    expect(screen.getByText(/0,04\s*€\/lead/)).toBeInTheDocument();
    // Tranche max = Infinity → affichage "50 000+" (Intl FR utilise espace
    // insécable étroit U+202F comme séparateur de milliers, on tolère \s).
    expect(screen.getByText(/50\s*000\+/)).toBeInTheDocument();
  });
});
