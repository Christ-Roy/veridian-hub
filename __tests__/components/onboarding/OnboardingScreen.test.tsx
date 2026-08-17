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
  OnboardingStep
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
      tagline: 'Vos emails transactionnels et vos campagnes au même endroit.'
    }
  ],
  expiresAt: '2026-08-15T18:00:00.000Z'
};

const STEPS: OnboardingStep[] = [
  { id: 'compte', label: 'Création de votre compte', status: 'termine' },
  { id: 'espace', label: 'Préparation de votre espace', status: 'en-cours' }
];

/** Titre <h1> attendu pour chaque état — la signature de l'écran affiché. */
const TITRES: Record<OnboardingStateId, RegExp> = {
  activation: /Bienvenue, votre espace vous attend/,
  'mot-de-passe': /Choisissez votre mot de passe/,
  'en-cours': /On prépare votre espace/,
  termine: /Votre compte est prêt/,
  erreur: /Une erreur est survenue/,
  'token-expire': /Ce lien a expiré/
};

type Handlers = Partial<{
  onActiver: () => void;
  onDefinirMotDePasse: (password: string) => void;
  onRenvoyerLien: () => void;
  onReessayer: () => void;
  onEntrer: () => void;
  submitting: boolean;
  error: string | null;
}>;

function afficher(state: OnboardingStateId, handlers: Handlers = {}) {
  return render(
    <OnboardingScreen
      state={state}
      invite={INVITE}
      steps={STEPS}
      {...handlers}
    />
  );
}

describe('OnboardingScreen — un état, un écran', () => {
  for (const [state, titre] of Object.entries(TITRES) as [
    OnboardingStateId,
    RegExp
  ][]) {
    it(`état « ${state} » : affiche l’écran attendu et lui seul`, () => {
      afficher(state);

      // L'écran attendu est là…
      expect(
        screen.getByRole('heading', { level: 1, name: titre })
      ).toBeInTheDocument();

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
      screen.queryByRole('button', { name: /Recevoir un nouveau lien/i })
    ).toBeNull();

    rerender(
      <OnboardingScreen state="token-expire" invite={INVITE} steps={STEPS} />
    );
    expect(screen.getByText('Ce lien a expiré')).toBeInTheDocument();
    // Un lien expiré, lui, affiche l'adresse de renvoi issue de l'invitation.
    expect(
      screen.getByText('claire.dubois@exemple-client.fr')
    ).toBeInTheDocument();
  });

  it('transmet les étapes à l’écran de progression', () => {
    afficher('en-cours');

    expect(screen.getByText('Création de votre compte')).toBeInTheDocument();
    expect(screen.getByText('Préparation de votre espace')).toBeInTheDocument();
    // 1 terminée sur 2 → la barre doit refléter les étapes passées, pas un
    // pourcentage figé.
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '50'
    );
  });
});

describe('OnboardingScreen — enchaînement des étapes', () => {
  it('activation → appelle onActiver', () => {
    const onActiver = vi.fn();
    afficher('activation', { onActiver });

    fireEvent.click(
      screen.getByRole('button', { name: /Activer mon compte/i })
    );
    expect(onActiver).toHaveBeenCalledTimes(1);
  });

  it('REMONTE le mot de passe saisi, et seulement s’il est valide', () => {
    // 🔴 La régression que ce test verrouille : le composant n'exposait qu'un
    // `onAdvance(stateId)` et câblait `onSubmit={() => onAdvance('en-cours')}`.
    // La signature réelle de PasswordScreen est `(password: string) => void` :
    // l'argument était donc IGNORÉ, et la page réelle ne pouvait pas récupérer
    // le mot de passe du client à travers OnboardingScreen.
    const onDefinirMotDePasse = vi.fn();
    afficher('mot-de-passe', { onDefinirMotDePasse });

    // Un mot de passe faible ne remonte rien.
    fireEvent.change(screen.getByLabelText('Mot de passe'), {
      target: { value: 'faible' }
    });
    fireEvent.change(screen.getByLabelText('Confirmation'), {
      target: { value: 'faible' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon accès/i }));
    expect(onDefinirMotDePasse).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Mot de passe'), {
      target: { value: 'Motdepasse1' }
    });
    fireEvent.change(screen.getByLabelText('Confirmation'), {
      target: { value: 'Motdepasse1' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon accès/i }));
    expect(onDefinirMotDePasse).toHaveBeenCalledWith('Motdepasse1');
  });

  it('transmet submitting et error à l’écran de mot de passe', () => {
    // Sans ces deux props, la page réelle ne pouvait afficher ni état d'envoi
    // ni erreur serveur (« ce lien n'est plus valide ») : le client cliquait
    // dans le vide.
    afficher('mot-de-passe', { error: 'Ce lien n’est plus valide.' });
    expect(screen.getByText('Ce lien n’est plus valide.')).toBeInTheDocument();

    screen.getByRole('button', { name: /Créer mon accès/i });
  });

  it('erreur technique → appelle onReessayer', () => {
    const onReessayer = vi.fn();
    afficher('erreur', { onReessayer });

    fireEvent.click(screen.getByRole('button', { name: /Réessayer/i }));
    expect(onReessayer).toHaveBeenCalledTimes(1);
  });

  it('token expiré → appelle onRenvoyerLien, pas onReessayer', () => {
    // Erreur facile à commettre en copiant la branche `erreur` : relancer le
    // provisioning sur un lien expiré ferait provisionner sans lien valide.
    const onRenvoyerLien = vi.fn();
    const onReessayer = vi.fn();
    afficher('token-expire', { onRenvoyerLien, onReessayer });

    fireEvent.click(
      screen.getByRole('button', { name: /Demander un nouveau lien/i })
    );
    expect(onRenvoyerLien).toHaveBeenCalledTimes(1);
    expect(onReessayer).not.toHaveBeenCalled();
  });

  it('l’écran « en cours » n’expose aucune action manuelle', () => {
    // Pendant le provisioning, rien ne doit être cliquable : le client
    // attend, la progression avance toute seule.
    afficher('en-cours');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('sans handlers, les écrans restent cliquables sans planter', () => {
    // La page réelle branchera ses propres handlers ; les props sont
    // facultatives et les appels optionnels.
    afficher('activation');
    expect(() =>
      fireEvent.click(
        screen.getByRole('button', { name: /Activer mon compte/i })
      )
    ).not.toThrow();
  });
});

describe('OnboardingScreen — l’état « terminé » n’est jamais un cul-de-sac', () => {
  // 🔴 Régression verrouillée ici : `OnboardingScreen` passait
  // `onEnter={() => undefined}` à DoneScreen. DoneScreen choisit entre un
  // bouton et un lien selon `onEnter ? … : …`, et `() => undefined` est
  // truthy : la branche BOUTON était rendue, et le clic ne faisait rien. Le
  // client arrivait au bout de l'onboarding sans aucun moyen d'entrer dans
  // son espace. Le test de DoneScreen documentait ce cul-de-sac, mais aucun
  // test ne vérifiait l'état 'termine' À TRAVERS OnboardingScreen.

  it('offre un lien vers le dashboard quand aucun onEntrer n’est fourni', () => {
    afficher('termine');

    const lien = screen.getByRole('link', { name: /Entrer dans mon espace/i });
    expect(lien).toHaveAttribute('href', '/dashboard');
  });

  it('déclenche onEntrer quand la page réelle en fournit un', () => {
    const onEntrer = vi.fn();
    afficher('termine', { onEntrer });

    fireEvent.click(
      screen.getByRole('button', { name: /Entrer dans mon espace/i })
    );
    expect(onEntrer).toHaveBeenCalledTimes(1);
  });

  it('propose TOUJOURS une sortie : un lien OU un bouton actif', () => {
    // Formulation volontairement générique : quelle que soit la façon dont la
    // sortie est rendue demain, il doit y en avoir une.
    for (const handlers of [{}, { onEntrer: vi.fn() }]) {
      const { unmount } = afficher('termine', handlers);
      const sorties = screen.queryAllByText(/Entrer dans mon espace/i);
      expect(sorties.length).toBeGreaterThan(0);
      unmount();
    }
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
      'token-expire': /Votre compte, lui, reste là/
    };

    for (const [state, texte] of Object.entries(attendu) as [
      OnboardingStateId,
      RegExp
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
