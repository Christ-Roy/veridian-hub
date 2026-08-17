/**
 * Tests de `components/onboarding/ProgressScreen.tsx` — écran 3, l'activation
 * en cours.
 *
 * Cet écran a une vraie logique : il calcule un pourcentage à partir du statut
 * des étapes et le pousse dans un `role="progressbar"`. C'est là que se
 * cachent les bugs classiques (division par zéro sur liste vide, arrondi,
 * accord du pluriel), et c'est la seule information que le client a pour
 * décider s'il attend ou s'il referme l'onglet.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProgressScreen } from '@/components/onboarding/ProgressScreen';
import type { OnboardingStep } from '@/components/onboarding/types';

const ETAPES: OnboardingStep[] = [
  { id: 'compte', label: 'Création de votre compte', status: 'termine' },
  {
    id: 'espace',
    label: 'Préparation de votre espace de travail',
    status: 'en-cours',
    detail: 'Quelques secondes, on installe vos outils.',
  },
  { id: 'apps', label: 'Activation de vos applications', status: 'a-venir' },
  { id: 'bienvenue', label: 'Envoi de votre email de bienvenue', status: 'a-venir' },
];

describe('ProgressScreen — calcul de progression', () => {
  it('reflète la part d’étapes terminées dans la barre de progression', () => {
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={ETAPES} />);

    // 1 terminée sur 4 → 25 %.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/1 étape sur 4/)).toBeInTheDocument();
  });

  it('atteint 100 % quand toutes les étapes sont terminées', () => {
    const toutes = ETAPES.map((s) => ({ ...s, status: 'termine' as const }));
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={toutes} />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText(/4 étapes sur 4/)).toBeInTheDocument();
  });

  it('reste à 0 % tant qu’aucune étape n’est terminée', () => {
    const aucune = ETAPES.map((s) => ({ ...s, status: 'a-venir' as const }));
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={aucune} />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText(/0 étape sur 4/)).toBeInTheDocument();
  });

  it('ne compte pas une étape en échec comme terminée', () => {
    // Régression à verrouiller : un provisioning tombé en panne ne doit pas
    // faire avancer la barre, sinon le client croit que ça marche.
    const avecEchec: OnboardingStep[] = [
      { id: 'a', label: 'A', status: 'termine' },
      { id: 'b', label: 'B', status: 'echec' },
      { id: 'c', label: 'C', status: 'a-venir' },
      { id: 'd', label: 'D', status: 'a-venir' },
    ];
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={avecEchec} />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('accorde le pluriel de « étape » sur le compte réel', () => {
    const une = [{ id: 'a', label: 'A', status: 'termine' as const }];
    const { rerender } = render(
      <ProgressScreen workspaceName="Atelier Dubois" steps={une} />,
    );
    expect(screen.getByText(/1 étape sur 1/)).toBeInTheDocument();

    rerender(
      <ProgressScreen
        workspaceName="Atelier Dubois"
        steps={[...une, { id: 'b', label: 'B', status: 'termine' as const }]}
      />,
    );
    expect(screen.getByText(/2 étapes sur 2/)).toBeInTheDocument();
  });

  it('ne produit pas NaN sur une liste d’étapes vide', () => {
    // `done / steps.length` avec une liste vide donnait NaN, qui partait tel
    // quel dans `aria-valuenow` et dans le `width` du style (déclaration CSS
    // invalide → barre de largeur indéfinie). L'assertion précédente
    // acceptait `'0' || 'NaN'` : elle passait donc que le composant soit
    // correct OU cassé, sur le seul calcul réel du fichier. Elle est
    // maintenant stricte.
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={[]} />);

    const barre = screen.getByRole('progressbar');
    expect(barre).toHaveAttribute('aria-valuenow', '0');
    expect(barre.querySelector('div')).toHaveStyle({ width: '0%' });
    expect(screen.getByText(/0 étape sur 0/)).toBeInTheDocument();
  });
});

describe('ProgressScreen — rendu des étapes', () => {
  it('affiche le libellé de chaque étape', () => {
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={ETAPES} />);

    for (const etape of ETAPES) {
      expect(screen.getByText(etape.label)).toBeInTheDocument();
    }
  });

  it('affiche le détail seulement quand l’étape en porte un', () => {
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={ETAPES} />);

    expect(
      screen.getByText('Quelques secondes, on installe vos outils.'),
    ).toBeInTheDocument();
    // Les trois autres étapes n'ont pas de détail : rien d'autre ne doit
    // apparaître sous leur libellé.
    expect(screen.getAllByText(/Quelques secondes/)).toHaveLength(1);
  });

  it('annonce le statut de chaque étape aux lecteurs d’écran', () => {
    // L'état d'une étape n'est signalé visuellement que par une icône
    // `aria-hidden` : sans le texte `sr-only`, l'écran est muet pour un
    // lecteur d'écran.
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={ETAPES} />);

    expect(screen.getByText(/— Terminé/)).toBeInTheDocument();
    expect(screen.getByText(/— En cours/)).toBeInTheDocument();
    expect(screen.getAllByText(/— En attente/)).toHaveLength(2);
  });

  it('rappelle le nom de l’espace en préparation', () => {
    render(<ProgressScreen workspaceName="Atelier Dubois" steps={ETAPES} />);
    expect(screen.getByText(/Atelier Dubois/)).toBeInTheDocument();
  });
});
