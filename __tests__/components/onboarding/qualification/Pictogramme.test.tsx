/**
 * Tests de `Pictogramme` — les dessins vectoriels de l'onboarding.
 *
 * Ils existent pour deux raisons, et ce sont exactement les deux propriétés
 * qu'on vérifie ici : ils tiennent leur lisibilité à 120 px de haut (donc
 * pas de micro-détail, mais ça ne se teste pas en JSDOM), et ils héritent
 * des variables de couleur du thème — c'est ce qui évite le bloc blanc
 * éblouissant des captures sur fond nuit.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Pictogramme } from '@/components/onboarding/qualification/Pictogramme';
import { ILLUSTRATIONS } from '@/components/onboarding/qualification/illustrations';
import type { ClePictogramme } from '@/components/onboarding/qualification/illustrations';

const TOUTES: ClePictogramme[] = [
  'espace',
  'site',
  'chantier',
  'email',
  'prospection',
  'calendrier',
  'celebration',
];

describe('Pictogramme — couverture du registre', () => {
  it('dessine chacune des clés annoncées', () => {
    for (const cle of TOUTES) {
      const { container, unmount } = render(<Pictogramme cle={cle} />);
      const svg = container.querySelector('svg')!;
      expect(svg.childElementCount, cle).toBeGreaterThan(0);
      unmount();
    }
  });

  it('couvre tous les pictogrammes référencés par les illustrations', () => {
    // Une illustration qui pointerait sur un dessin inexistant rendrait un
    // SVG vide, donc un trou silencieux au milieu de l'écran.
    for (const spec of Object.values(ILLUSTRATIONS)) {
      expect(TOUTES).toContain(spec.pictogramme);
    }
  });
});

describe('Pictogramme — couleurs et accessibilité', () => {
  it('hérite de la couleur du thème, jamais d’une valeur en dur', () => {
    const { container } = render(<Pictogramme cle="site" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toContain('text-primary');
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(svg.outerHTML).not.toMatch(/rgb\(/);
  });

  it('est décoratif par défaut', () => {
    const { container } = render(<Pictogramme cle="site" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('devient une image nommée quand on lui donne un titre', () => {
    render(<Pictogramme cle="site" titre="Un site en ligne et son audience" />);
    expect(
      screen.getByRole('img', { name: 'Un site en ligne et son audience' }),
    ).toBeInTheDocument();
  });

  it('reste hors du parcours de tabulation', () => {
    // Un SVG focusable piège le clavier sous IE/Edge legacy et pollue le Tab.
    const { container } = render(<Pictogramme cle="site" />);
    expect(container.querySelector('svg')).toHaveAttribute('focusable', 'false');
  });
});
