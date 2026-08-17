/**
 * Tests de `ChoiceCard` — la carte de réponse de l'onboarding qualifiant.
 *
 * Deux choses s'y jouent, et les deux étaient cassées :
 *   - la sémantique (c'était un `<button aria-pressed>` isolé, annoncé
 *     « bouton, enfoncé » sur des choix pourtant exclusifs) ;
 *   - la couleur de la sélection, rendue en noir sur gris via `--primary`,
 *     donc lue comme désactivée dans un thème où `--primary` est neutre.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ChoiceCard } from '@/components/onboarding/qualification/ChoiceCard';

function afficher(props: Partial<React.ComponentProps<typeof ChoiceCard>> = {}) {
  return render(
    <ChoiceCard
      label="Le refaire"
      description="Le fond est bon, la forme a vieilli."
      selectionnee={false}
      onSelect={() => {}}
      {...props}
    />,
  );
}

describe('ChoiceCard — sémantique de groupe', () => {
  it('est un bouton radio, pas un bouton à bascule', () => {
    afficher();
    const carte = screen.getByRole('radio');
    expect(carte).toHaveAttribute('aria-checked', 'false');
    // `aria-pressed` annonçait « enfoncé » sur un choix exclusif.
    expect(carte).not.toHaveAttribute('aria-pressed');
  });

  it('reflète la sélection dans aria-checked', () => {
    afficher({ selectionnee: true });
    expect(screen.getByRole('radio')).toHaveAttribute('aria-checked', 'true');
  });

  it('sort du parcours de tabulation quand elle n’est pas l’option active', () => {
    // Focus roving : tout le groupe ne compte que pour UN arrêt de tabulation.
    afficher({ tabulable: false });
    expect(screen.getByRole('radio')).toHaveAttribute('tabindex', '-1');
  });

  it('remonte les touches au parent pour la navigation aux flèches', () => {
    const onKeyDown = vi.fn();
    afficher({ onKeyDown });
    fireEvent.keyDown(screen.getByRole('radio'), { key: 'ArrowDown' });
    expect(onKeyDown).toHaveBeenCalled();
  });
});

describe('ChoiceCard — un clic répond ET avance', () => {
  it('appelle onSelect au clic', () => {
    const onSelect = vi.fn();
    afficher({ onSelect });
    fireEvent.click(screen.getByRole('radio'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('affiche le libellé et sa description', () => {
    afficher();
    expect(screen.getByText('Le refaire')).toBeInTheDocument();
    expect(
      screen.getByText('Le fond est bon, la forme a vieilli.'),
    ).toBeInTheDocument();
  });
});

describe('ChoiceCard — la sélection porte la couleur de marque', () => {
  it('n’habille PAS la carte choisie avec les variables neutres', () => {
    // 🔴 Régression verrouillée : `border-primary bg-accent ring-primary`.
    // Dans ce thème `--primary` est un noir neutre et `--accent` un gris
    // neutre : la carte choisie devenait grise cerclée de noir au milieu
    // d'un fond ambre/rose, donc plus terne que les cartes NON choisies.
    afficher({ selectionnee: true });
    const carte = screen.getByRole('radio');
    expect(carte.className).not.toContain('border-primary');
    expect(carte.className).not.toContain('ring-primary');
  });

  it('applique la classe de sélection dédiée', () => {
    afficher({ selectionnee: true });
    expect(screen.getByRole('radio')).toHaveClass('choice-selected');
  });

  it('n’applique rien de tout ça quand la carte n’est pas choisie', () => {
    afficher({ selectionnee: false });
    expect(screen.getByRole('radio')).not.toHaveClass('choice-selected');
  });
});
