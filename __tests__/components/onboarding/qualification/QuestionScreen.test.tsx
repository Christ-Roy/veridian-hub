/**
 * Tests de `QuestionScreen` — la mise en page qui doit tenir en hauteur.
 *
 * C'était le bloquant du lot : à 375×667 (un iPhone SE, et aussi ce que vaut
 * 100dvh sur un iPhone 13 barre d'adresse déployée), la 4e option des écrans
 * à quatre réponses était hors écran ; à 375×568, deux réponses manquaient et
 * le pied disparaissait aussi. Sans le moindre indice de défilement : le
 * client croyait que la question n'avait que deux ou trois réponses.
 *
 * On ne peut pas mesurer des pixels en JSDOM, mais on peut verrouiller les
 * DÉCISIONS de mise en page qui règlent le problème — c'est-à-dire ce qu'une
 * refonte future casserait sans s'en apercevoir.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { QuestionScreen } from '@/components/onboarding/qualification/QuestionScreen';
import { ECRANS_QUESTIONS } from '@/components/onboarding/qualification/questions';
import type { OnboardingUser } from '@/components/onboarding/qualification/types';

const USER: OnboardingUser = {
  prenom: 'Claire',
  email: 'claire@exemple.fr',
  workspaceName: 'Atelier Dubois',
};

const ecranPar = (id: string) => ECRANS_QUESTIONS.find((e) => e.id === id)!;

function afficher(id: string, valeur?: string) {
  return render(
    <QuestionScreen
      ecran={ecranPar(id)}
      user={USER}
      valeur={valeur}
      onRepondre={vi.fn()}
    />,
  );
}

describe('QuestionScreen — tenir en hauteur sur un petit téléphone', () => {
  it('passe en DEUX colonnes dès le plus petit écran au-delà de 3 options', () => {
    // 🔴 C'est la parade principale : `sm:grid-cols-2` ne s'appliquait qu'à
    // partir de 640 px, donc jamais sur les téléphones concernés. Les quatre
    // cartes s'empilaient et débordaient.
    const { container } = afficher('prospection');
    const groupe = container.querySelector('[role="radiogroup"]')!;
    expect(groupe).toHaveClass('grid-cols-2');
    expect(groupe.className).not.toContain('sm:grid-cols-2');
  });

  it('garde une seule colonne quand les options tiennent', () => {
    const { container } = afficher('site-actuel');
    expect(container.querySelector('[role="radiogroup"]')).toHaveClass('grid-cols-1');
  });

  it('masque l’illustration sous 640 px de HAUTEUR', () => {
    // Elle valait 18dvh, soit une centaine de pixels pris à des réponses déjà
    // coupées — et elle ne transmettait rien à cette taille.
    const { container } = afficher('prospection');
    const zoneVisuelle = container.querySelector('.haut\\:block');
    expect(zoneVisuelle).not.toBeNull();
    expect(zoneVisuelle).toHaveClass('hidden');
  });
});

describe('QuestionScreen — groupe de réponses accessible', () => {
  it('relie le groupe au titre de la question', () => {
    const { container } = afficher('prospection');
    const groupe = container.querySelector('[role="radiogroup"]')!;
    const titre = screen.getByRole('heading', { level: 1 });
    expect(groupe.getAttribute('aria-labelledby')).toBe(titre.id);
  });

  it('rend une option par réponse possible', () => {
    afficher('prospection');
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('marque comme cochée la réponse déjà donnée', () => {
    afficher('prospection', 'b2c');
    const coche = screen
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(coche).toHaveLength(1);
    expect(coche[0]).toHaveTextContent('Je vends aux particuliers');
  });

  it('place le roving sur la réponse déjà donnée, pas sur la première', () => {
    afficher('prospection', 'b2c');
    const tabulables = screen
      .getAllByRole('radio')
      .filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabulables).toHaveLength(1);
    expect(tabulables[0]).toHaveTextContent('Je vends aux particuliers');
  });

  it('rend le titre focusable pour la navigation entre écrans', () => {
    afficher('site-actuel');
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });
});

describe('QuestionScreen — contenu affiché', () => {
  it('affiche la question et son sous-titre', () => {
    afficher('prospection');
    expect(
      screen.getByRole('heading', { name: /clients professionnels/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/filtrables par métier/i)).toBeInTheDocument();
  });
});
