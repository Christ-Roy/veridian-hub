/**
 * Tests pour components/auth/provider-icons.tsx — module partagé des SVG de
 * marque Google / Microsoft (source unique extraite de OAuthButtons et
 * InviteSignInOptions qui les dupliquaient).
 *
 * Vérifie :
 *  - les 2 icônes rendent un <svg>
 *  - les viewBox de marque sont préservés (24x24 Google, 23x23 Microsoft)
 *  - les SVG sont aria-hidden (le label texte du bouton porte le sens)
 *  - les couleurs officielles de marque sont conservées (pas tokenisées OKLCH)
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GoogleIcon, MicrosoftIcon } from '@/components/auth/provider-icons';

describe('GoogleIcon', () => {
  it('rend un <svg> avec le viewBox de marque 24x24', () => {
    const { container } = render(<GoogleIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('est aria-hidden (décoratif — le label texte du bouton porte le sens)', () => {
    const { container } = render(<GoogleIcon />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('conserve les couleurs officielles Google (pas de token OKLCH)', () => {
    // Le bleu Google #4285F4 est une couleur de marque imposée — elle ne
    // doit jamais être remplacée par un token du design system Veridian.
    const { container } = render(<GoogleIcon />);
    const fills = Array.from(container.querySelectorAll('path')).map((p) =>
      p.getAttribute('fill'),
    );
    expect(fills).toContain('#4285F4');
    expect(fills).toContain('#EA4335');
  });
});

describe('MicrosoftIcon', () => {
  it('rend un <svg> avec le viewBox de marque 23x23', () => {
    const { container } = render(<MicrosoftIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 23 23');
  });

  it('est aria-hidden (décoratif)', () => {
    const { container } = render(<MicrosoftIcon />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('rend les 4 carrés de couleurs officielles Microsoft', () => {
    const { container } = render(<MicrosoftIcon />);
    const fills = Array.from(container.querySelectorAll('path')).map((p) =>
      p.getAttribute('fill'),
    );
    // Les 4 couleurs du logo Microsoft.
    expect(fills).toEqual(
      expect.arrayContaining(['#f25022', '#7fba00', '#00a4ef', '#ffb900']),
    );
  });
});
