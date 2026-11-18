/**
 * Tests de `components/onboarding/OnboardingScreen.tsx` — l'aiguilleur du flow
 * de première connexion.
 *
 * Ce composant est le seul point d'entrée : la future page `/onboard/[token]`
 * calculera `state` côté serveur et lui passera la main. Tout ce qu'il fait,
 * c'est choisir UN écran parmi six et câbler ses transitions. Deux familles de
 * bugs sont donc possibles, et toutes deux invisibles à l'œil dans l'atelier :
 *
 *  1. Un état qui affiche le mauvais écran, ou deux écrans à la fois (les
 *     rendus conditionnels sont écrits en `&&` juxtaposés, pas en switch : rien
 *     n'interdit structurellement le chevauchement).
 *  2. Une transition qui renvoie vers le mauvais état — typiquement
 *     `token-expire` qui doit retomber sur `activation` et non sur `en-cours`.
 *
 * On vérifie aussi que la baseline du panneau de marque suit l'état, puisque
 * c'est le seul élément de contexte visible pendant les étapes muettes.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { OnboardingScreen } from '@/components/onboarding/OnboardingScreen';
import type {
  OnboardingInvite,
  OnboardingStateId,
  OnboardingStep,
} from '@/components/onboarding/types';

const INVITE: OnboardingInvite = {
  email: 'claire.dubois@exemple-client.fr',
  workspaceName: 'Atelier Dubois',
  invitedBy: 'Robert Brunon',
  apps: [
    {
      id: 'notifuse',
      label: 'Mail',
      suffix: '.mail',
      tagline: 'Vos emails transactionnels et vos campagnes au même endroit.',
    },
  ],
  expiresAt: '2026-08-15T18:00:00.000Z',
};

const STEPS: OnboardingStep[] = [
  { id: 'compte', label: 'Création de votre compte', status: 'termine' },
  { id: 'espace', label: 'Préparation de votre espace', status: 'en-cours' },
];

/** Titre <h1> attendu pour chaque état — la signature de l'écran affiché. */
const TITRES: Record<OnboardingStateId, RegExp> = {
  activation: /Bienvenue, votre espace vous attend/,
  'mot-de-passe': /Choisissez votre mot de passe/,
  'en-cours': /On prépare votre espace/,
  termine: /Votre compte est prêt/,
  erreur: /Une erreur est survenue/,
  'token-expire': /Ce lien a expiré/,
};

function afficher(
  state: OnboardingStateId,
  onAdvance?: (next: OnboardingStateId) => void,
) {
  return render(
    <OnboardingScreen
      state={state}
      invite={INVITE}
      steps={STEPS}
      onAdvance={onAdvance}
    />,
  );
}

describe('OnboardingScreen — un état, un écran', () => {
  for (const [state, titre] of Object.entries(TITRES) as [
    OnboardingStateId,
    RegExp,
  ][]) {
    it(`état « ${state} » : affiche l’écran attendu et lui seul`, () => {
      afficher(state);

      // L'écran attendu est là…
      expect(screen.getByRole('heading', { level: 1, name: titre })).toBeInTheDocument();

      // …et aucun autre écran ne s'affiche en même temps. C'est le vrai test :
      // les rendus sont juxtaposés en `&&`, un état mal comparé en montrerait
      // deux d'un coup.
      const titres = screen.getAllByRole('heading', { level: 1 });
      expect(titres).toHaveLength(1);
    });
  }

  it('distingue les deux variantes d’erreur, qui partagent le même composant', () => {
    const { rerender } = afficher('erreur');
    expect(screen.getByText('Une erreur est survenue')).toBeInTheDocument();
    // Une panne de provisioning ne propose pas de renvoi de lien.
    expect(
      screen.queryByRole('button', { name: /Recevoir un nouveau lien/i }),
    ).toBeNull();

    rerender(
      <OnboardingScreen state="token-expire" invite={INVITE} steps={STEPS} />,
    );
    expect(screen.getByText('Ce lien a expiré')).toBeInTheDocument();
    // Un lien expiré, lui, affiche l'adresse de renvoi issue de l'invitation.
    expect(
      screen.getByText('claire.dubois@exemple-client.fr'),
    ).toBeInTheDocument();
  });

  it('transmet les étapes à l’écran de progression', () => {
    afficher('en-cours');

    expect(screen.getByText('Création de votre compte')).toBeInTheDocument();
    expect(screen.getByText('Préparation de votre espace')).toBeInTheDocument();
    // 1 terminée sur 2 → la barre doit refléter les étapes passées, pas un
    // pourcentage figé.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });
});

describe('OnboardingScreen — enchaînement des étapes', () => {
  it('activation → mot-de-passe', () => {
    const onAdvance = vi.fn();
    afficher('activation', onAdvance);

    fireEvent.click(screen.getByRole('button', { name: /Activer mon compte/i }));
    expect(onAdvance).toHaveBeenCalledWith('mot-de-passe');
  });

  it('mot-de-passe → en-cours, seulement après un mot de passe valide', () => {
    const onAdvance = vi.fn();
    afficher('mot-de-passe', onAdvance);

    // Un mot de passe faible ne fait pas avancer le flow.
    fireEvent.change(screen.getByLabelText('Mot de passe'), {
      target: { value: 'faible' },
    });
    fireEvent.change(screen.getByLabelText('Confirmation'), {
      target: { value: 'faible' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon accès/i }));
    expect(onAdvance).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Mot de passe'), {
      target: { value: 'Motdepasse1' },
    });
    fireEvent.change(screen.getByLabelText('Confirmation'), {
      target: { value: 'Motdepasse1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon accès/i }));
    expect(onAdvance).toHaveBeenCalledWith('en-cours');
  });

  it('erreur technique → relance le provisioning (en-cours)', () => {
    const onAdvance = vi.fn();
    afficher('erreur', onAdvance);

    fireEvent.click(screen.getByRole('button', { name: /Réessayer/i }));
    expect(onAdvance).toHaveBeenCalledWith('en-cours');
  });

  it('token expiré → repart du début (activation), pas du provisioning', () => {
    // Erreur facile à commettre en copiant la branche `erreur` : relancer
    // `en-cours` sur un lien expiré ferait provisionner sans lien valide.
    const onAdvance = vi.fn();
    afficher('token-expire', onAdvance);

    fireEvent.click(
      screen.getByRole('button', { name: /Recevoir un nouveau lien/i }),
    );
    expect(onAdvance).toHaveBeenCalledWith('activation');
  });

  it('l’écran « en cours » n’expose aucune action manuelle', () => {
    // Pendant le provisioning, rien ne doit être cliquable : le client
    // attend, la progression avance toute seule.
    const onAdvance = vi.fn();
    afficher('en-cours', onAdvance);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('sans onAdvance, les écrans restent cliquables sans planter', () => {
    // La page réelle branchera ses propres handlers ; la prop est facultative
    // et l'appel est optionnel (`onAdvance?.(...)`).
    afficher('activation');
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /Activer mon compte/i })),
    ).not.toThrow();
  });
});

describe('OnboardingScreen — panneau de marque', () => {
  it('adapte la baseline à chaque état', () => {
    const attendu: Record<OnboardingStateId, RegExp> = {
      activation: /Il ne manque plus que vous/,
      'mot-de-passe': /Un seul mot de passe pour tous vos outils/,
      'en-cours': /Vos outils s’installent/,
      termine: /Bienvenue chez Veridian/,
      erreur: /On règle ça ensemble/,
      'token-expire': /Votre compte, lui, reste là/,
    };

    for (const [state, texte] of Object.entries(attendu) as [
      OnboardingStateId,
      RegExp,
    ][]) {
      const { unmount } = afficher(state);
      expect(screen.getByText(texte), state).toBeInTheDocument();
      unmount();
    }
  });

  it('conserve l’habillage commun quel que soit l’état', () => {
    // Le shell (logo + écosystème) doit rester présent même sur les écrans
    // d'erreur : c'est ce qui distingue une panne Veridian d'une page morte.
    for (const state of ['activation', 'erreur', 'token-expire'] as const) {
      const { unmount } = afficher(state);
      // Pill de l'AppTree : le suffixe est le noeud de texte adressable.
      // `getAllByText` car l'écran d'activation affiche lui aussi le
      // wordmark `.mail` dans sa liste d'apps.
      expect(screen.getAllByText('.mail').length, state).toBeGreaterThan(0);
      unmount();
    }
  });
});
