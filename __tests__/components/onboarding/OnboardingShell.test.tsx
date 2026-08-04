/**
 * Tests de `components/onboarding/OnboardingShell.tsx` — l'habillage commun
 * des écrans d'onboarding.
 *
 * Le shell n'a pas d'état, mais il porte une promesse : la première connexion
 * d'un client doit ressembler à `/login`, pas à une page étrangère. Concrètement
 * il doit toujours rendre le contenu de l'étape, la marque Veridian, et une
 * baseline pilotée par l'appelant. C'est un Server Component : s'il attrapait
 * un jour un hook ou un handler, ce test le ferait tomber.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OnboardingShell } from '@/components/onboarding/OnboardingShell';

describe('OnboardingShell — contenu de l’étape', () => {
  it('rend les enfants qu’on lui confie', () => {
    render(
      <OnboardingShell>
        <p>Contenu de l’étape en cours</p>
      </OnboardingShell>,
    );
    expect(screen.getByText('Contenu de l’étape en cours')).toBeInTheDocument();
  });

  it('n’avale pas les enfants multiples', () => {
    render(
      <OnboardingShell>
        <h1>Titre</h1>
        <button type="button">Action</button>
      </OnboardingShell>,
    );

    expect(screen.getByRole('heading', { name: 'Titre' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  });
});

describe('OnboardingShell — panneau de marque', () => {
  it('affiche une baseline par défaut quand l’appelant n’en donne pas', () => {
    render(
      <OnboardingShell>
        <p>x</p>
      </OnboardingShell>,
    );
    expect(
      screen.getByText(
        'Votre espace Veridian est prêt. Il ne manque plus que vous.',
      ),
    ).toBeInTheDocument();
  });

  it('affiche la baseline fournie par l’écran courant', () => {
    render(
      <OnboardingShell brandBaseline="Vos outils s’installent.">
        <p>x</p>
      </OnboardingShell>,
    );

    expect(screen.getByText('Vos outils s’installent.')).toBeInTheDocument();
    expect(
      screen.queryByText(/Il ne manque plus que vous/),
    ).toBeNull();
  });

  it('affiche l’écosystème Veridian sous le logo', () => {
    // L'AppTree est ce qui rattache visuellement la page au reste de la suite :
    // sans elle, l'écran devient un formulaire anonyme.
    render(
      <OnboardingShell>
        <p>x</p>
      </OnboardingShell>,
    );
    // Les pills sont rendues en deux noeuds ("veridian" + ".mail") : on vise
    // le suffixe, qui est le noeud de texte réellement adressable.
    expect(screen.getByText('.mail')).toBeInTheDocument();
    expect(screen.getByText('.prospection')).toBeInTheDocument();
  });
});

describe('OnboardingShell — mise en page', () => {
  it('applique la classe d’écran auth et accepte une surcharge', () => {
    const { container } = render(
      <OnboardingShell className="test-surcharge">
        <p>x</p>
      </OnboardingShell>,
    );

    const racine = container.firstElementChild as HTMLElement;
    expect(racine).toHaveClass('auth-screen');
    expect(racine).toHaveClass('min-h-screen');
    expect(racine).toHaveClass('test-surcharge');
  });
});
