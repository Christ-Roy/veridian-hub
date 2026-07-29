/**
 * Tests de `components/onboarding/ActivationScreen.tsx` — écran 1 du flow de
 * première connexion client.
 *
 * Ce qui compte ici, c'est la confiance : le destinataire arrive depuis un
 * email et doit reconnaître qui l'invite, sur quel espace, avec quels outils,
 * avant qu'on lui demande quoi que ce soit. Un rendu qui perd l'une de ces
 * informations rend l'écran indiscernable d'un phishing.
 *
 * On couvre donc : la projection des données de l'invitation, la liste d'apps
 * pilotée par la donnée (0, 1 ou N), le déclenchement de la navigation, et le
 * formatage français de l'échéance (`formatEcheance`, export public).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  ActivationScreen,
  formatEcheance,
} from '@/components/onboarding/ActivationScreen';
import type { OnboardingInvite } from '@/components/onboarding/types';

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
    {
      id: 'prospection',
      label: 'Prospection',
      suffix: '.prospection',
      tagline: 'Trouvez et qualifiez vos prospects sans quitter votre espace.',
    },
  ],
  expiresAt: '2026-08-15T18:00:00.000Z',
};

describe('ActivationScreen — projection de l’invitation', () => {
  it('affiche qui invite, sur quel espace, et l’identifiant du destinataire', () => {
    render(<ActivationScreen invite={INVITE} />);

    // L'invitant et l'espace sont dans le même paragraphe, découpé par un
    // <span> : on interroge le conteneur plutôt que des noeuds de texte.
    expect(screen.getByText(/Robert Brunon/)).toBeInTheDocument();
    expect(screen.getByText('Atelier Dubois')).toBeInTheDocument();
    expect(screen.getByText('claire.dubois@exemple-client.fr')).toBeInTheDocument();
  });

  it('liste une ligne par app rattachée, avec sa promesse', () => {
    render(<ActivationScreen invite={INVITE} />);

    expect(
      screen.getByText(/Vos emails transactionnels et vos campagnes/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Trouvez et qualifiez vos prospects/),
    ).toBeInTheDocument();
  });

  it('ne casse pas quand aucune app n’est encore rattachée', () => {
    // Cas réel : un tenant créé sans app liée. L'écran doit rester utilisable
    // (le bouton d'activation ne doit pas disparaître avec la liste vide).
    render(<ActivationScreen invite={{ ...INVITE, apps: [] }} />);

    expect(
      screen.getByRole('button', { name: /Activer mon compte/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Vos emails transactionnels/),
    ).toBeNull();
  });
});

describe('ActivationScreen — navigation', () => {
  it('appelle onContinue au clic sur « Activer mon compte »', () => {
    const onContinue = vi.fn();
    render(<ActivationScreen invite={INVITE} onContinue={onContinue} />);

    fireEvent.click(screen.getByRole('button', { name: /Activer mon compte/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('sans onContinue, le clic ne jette pas (prop facultative)', () => {
    render(<ActivationScreen invite={INVITE} />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /Activer mon compte/i })),
    ).not.toThrow();
  });
});

describe('formatEcheance — échéance lisible par le client', () => {
  it('rend une date en français, sans heure', () => {
    // 18:00 UTC le 15 août = 20:00 à Paris, toujours le 15.
    expect(formatEcheance('2026-08-15T18:00:00.000Z')).toBe('15 août 2026');
  });

  it('applique le fuseau Europe/Paris, pas celui de la machine', () => {
    // 23:30 UTC le 15 août = 01:30 le 16 à Paris. Un formatage en UTC
    // annoncerait au client une échéance la veille de la vraie.
    expect(formatEcheance('2026-08-15T23:30:00.000Z')).toBe('16 août 2026');
  });

  it('jette sur une date absente ou illisible — fragilité connue et pistée', () => {
    // ⚠️ Comportement ACTUEL, volontairement figé ici plutôt que corrigé en
    // douce : `Intl.DateTimeFormat().format(new Date(''))` lève un
    // `RangeError: Invalid time value`, qui remonte jusqu'au rendu et fait
    // tomber TOUT l'écran d'activation — pas seulement la ligne d'échéance.
    //
    // Concrètement : un `expiresAt` vide ou mal formé côté serveur transforme
    // une invitation parfaitement valide en page blanche pour le client, sans
    // recours ni message.
    //
    // Ce test n'entérine pas le bug, il l'attrape : le jour où `formatEcheance`
    // renvoie un repli (chaîne vide, « bientôt »…), ce test échouera et devra
    // être retourné en `not.toThrow()`. Le composant n'est pas modifié ici :
    // ce lot ne livre que des tests.
    expect(() => formatEcheance('')).toThrow(RangeError);
    expect(() =>
      render(<ActivationScreen invite={{ ...INVITE, expiresAt: '' }} />),
    ).toThrow();
  });
});
