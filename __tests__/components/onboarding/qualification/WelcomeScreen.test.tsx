/**
 * Tests de `WelcomeScreen` — l'écran qui pose le contrat.
 *
 * Son rôle est de dire pourquoi on demande quelque chose et combien de temps
 * ça prend. Deux régressions y sont verrouillées : une promesse chiffrée qui
 * ne tenait plus (« Quatre questions » alors que le parcours en compte
 * quatre ou cinq selon les réponses), et l'absence totale d'humain sur les
 * six écrans.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { WelcomeScreen } from '@/components/onboarding/qualification/WelcomeScreen';
import type { OnboardingUser } from '@/components/onboarding/qualification/types';

const USER: OnboardingUser = {
  prenom: 'Claire',
  email: 'claire@exemple.fr',
  workspaceName: 'Atelier Dubois',
};

function afficher(onStart = vi.fn(), onSkip = vi.fn()) {
  render(<WelcomeScreen user={USER} onStart={onStart} onSkip={onSkip} />);
  return { onStart, onSkip };
}

describe('WelcomeScreen — le contrat posé au client', () => {
  it('l’accueille par son prénom et nomme son espace', () => {
    afficher();
    expect(screen.getByRole('heading', { name: /Bienvenue Claire/ })).toBeInTheDocument();
    expect(screen.getByText(/Atelier Dubois/)).toBeInTheDocument();
  });

  it('ne promet plus un nombre de questions qu’il ne tient pas', () => {
    // Le parcours compte 4 OU 5 écrans : l'échéance n'apparaît qu'avec un
    // chantier. Annoncer « Quatre questions » était faux une fois sur deux.
    afficher();
    expect(screen.queryByText(/Quatre questions/)).toBeNull();
    expect(screen.getByText(/Quelques questions rapides/)).toBeInTheDocument();
  });

  it('signe l’onboarding d’un nom, pas d’un « on » désincarné', () => {
    afficher();
    expect(screen.getByText('Robert, Veridian, Lyon.')).toBeInTheDocument();
  });

  it('annonce qu’un point ensemble est possible', () => {
    afficher();
    expect(screen.getByText(/on se cale un point ensemble si besoin/)).toBeInTheDocument();
  });
});

describe('WelcomeScreen — les deux sorties', () => {
  it('démarre le parcours', () => {
    const { onStart } = afficher();
    fireEvent.click(screen.getByRole('button', { name: /C’est parti/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('laisse toujours la porte de sortie vers l’espace', () => {
    // Un onboarding dont on ne peut pas sortir est un onboarding qu'on ferme.
    const { onSkip } = afficher();
    fireEvent.click(screen.getByRole('button', { name: /Plus tard/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
