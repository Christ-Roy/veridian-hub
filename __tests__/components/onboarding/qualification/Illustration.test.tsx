/**
 * Tests de `Illustration` — le choix du visuel selon l'écran et le thème.
 *
 * Deux défauts majeurs y sont verrouillés :
 *
 *  1. **Mobile.** L'image affichée mesurait 343×146 px pour une source déjà
 *     réduite de 1068×422, elle-même une capture d'un écran de 1848 px : le
 *     texte de l'interface capturée finissait autour de 4 px de haut. Sur
 *     quatre questions, le client voyait quatre rectangles indistincts, pour
 *     18 à 24 % de la hauteur volés à des réponses déjà coupées.
 *  2. **Thème sombre.** Toutes les captures sont prises en thème clair. Sur
 *     le fond nuit, chacune formait un bloc quasi blanc au centre de
 *     l'écran : la zone la plus lumineuse de la page, alors qu'elle ne porte
 *     aucune information, sur un onboarding qu'un client peut ouvrir le soir.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Illustration } from '@/components/onboarding/qualification/Illustration';

let themeCourant = 'light';
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: themeCourant }),
}));

describe('Illustration — le pictogramme porte le mobile', () => {
  it('rend TOUJOURS un dessin vectoriel, à côté de la capture', () => {
    themeCourant = 'light';
    const { container } = render(<Illustration cle="prospection" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('réserve la capture aux grands écrans et le dessin aux petits', () => {
    themeCourant = 'light';
    const { container } = render(<Illustration cle="prospection" />);

    const capture = container.querySelector('picture')!;
    expect(capture.className).toContain('lg:block');
    expect(capture).toHaveClass('hidden');

    const dessin = container.querySelector('svg')!.parentElement!;
    expect(dessin.className).toContain('lg:hidden');
  });

  it('décrit le visuel plutôt que de l’annoncer comme « illustration »', () => {
    themeCourant = 'light';
    render(<Illustration cle="prospection" />);
    expect(
      screen.getAllByRole('img', { name: /entreprises françaises/i }).length,
    ).toBeGreaterThan(0);
  });
});

describe('Illustration — thème sombre', () => {
  it('n’affiche AUCUNE capture claire sur fond nuit', () => {
    // Tant que les variantes sombres ne sont pas déposées, le dessin — qui
    // hérite des variables de couleur — porte l'écran seul.
    themeCourant = 'dark';
    const { container } = render(<Illustration cle="prospection" />);
    expect(container.querySelector('picture')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('reprend la capture dès qu’une variante sombre existe', () => {
    themeCourant = 'light';
    const { container } = render(<Illustration cle="prospection" />);
    expect(container.querySelector('img')).not.toBeNull();
  });
});

describe('Illustration — clé inconnue', () => {
  it('affiche un emplacement légendé plutôt qu’une image cassée', () => {
    themeCourant = 'light';
    render(<Illustration cle="cle-qui-nexiste-pas" />);
    expect(
      screen.getByRole('img', { name: /Visuel manquant pour « cle-qui-nexiste-pas »/ }),
    ).toBeInTheDocument();
  });
});
