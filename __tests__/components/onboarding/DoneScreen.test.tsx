/**
 * Tests de `components/onboarding/DoneScreen.tsx` — écran 4, l'onboarding
 * terminé.
 *
 * Deux comportements à verrouiller :
 *
 *  1. La sortie est double : un handler `onEnter` (l'atelier, ou une page qui
 *     veut intercepter) OU un vrai lien `<a href>` par défaut. Si le lien
 *     disparaît quand `onEnter` est absent, le client arrive au bout du flow
 *     sans aucun moyen d'entrer — cul-de-sac total.
 *  2. Les confettis partent une seule fois au montage, sans jamais bloquer le
 *     rendu si la lib de célébration échoue.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const celebrate = vi.fn();
vi.mock('@/lib/confetti', () => ({ celebrate: () => celebrate() }));

import { DoneScreen } from '@/components/onboarding/DoneScreen';
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
  ],
  expiresAt: '2026-08-15T18:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DoneScreen — sortie vers l’espace client', () => {
  it('sans onEnter : rend un vrai lien vers /dashboard', () => {
    render(<DoneScreen invite={INVITE} />);

    const lien = screen.getByRole('link', { name: /Entrer dans mon espace/i });
    expect(lien).toHaveAttribute('href', '/dashboard');
  });

  it('sans onEnter : la destination reste surchargeable', () => {
    render(<DoneScreen invite={INVITE} dashboardHref="/dashboard?bienvenue=1" />);

    expect(
      screen.getByRole('link', { name: /Entrer dans mon espace/i }),
    ).toHaveAttribute('href', '/dashboard?bienvenue=1');
  });

  it('avec onEnter : rend un bouton qui appelle le handler', () => {
    const onEnter = vi.fn();
    render(<DoneScreen invite={INVITE} onEnter={onEnter} />);

    // Le lien laisse la place au bouton : sinon on aurait deux sorties
    // concurrentes, dont une qui rechargerait la page en plein flow atelier.
    expect(screen.queryByRole('link', { name: /Entrer dans mon espace/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Entrer dans mon espace/i }));
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('offre toujours exactement une sortie, quelle que soit la configuration', () => {
    const { rerender } = render(<DoneScreen invite={INVITE} />);
    expect(screen.getAllByText(/Entrer dans mon espace/)).toHaveLength(1);

    rerender(<DoneScreen invite={INVITE} onEnter={vi.fn()} />);
    expect(screen.getAllByText(/Entrer dans mon espace/)).toHaveLength(1);
  });
});

describe('DoneScreen — récapitulatif', () => {
  it('rappelle l’espace activé et l’identifiant de connexion', () => {
    render(<DoneScreen invite={INVITE} />);

    expect(screen.getByText(/Atelier Dubois/)).toBeInTheDocument();
    expect(
      screen.getByText(/claire\.dubois@exemple-client\.fr/),
    ).toBeInTheDocument();
  });

  it('liste les outils disponibles', () => {
    render(<DoneScreen invite={INVITE} />);
    expect(
      screen.getByText(/Vos emails transactionnels et vos campagnes/),
    ).toBeInTheDocument();
  });

  it('reste utilisable si aucune app n’est rattachée', () => {
    render(<DoneScreen invite={{ ...INVITE, apps: [] }} />);

    expect(screen.getByText('Votre compte est prêt')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Entrer dans mon espace/i }),
    ).toBeInTheDocument();
  });
});

describe('DoneScreen — célébration', () => {
  it('déclenche les confettis une seule fois au montage', () => {
    const { rerender } = render(<DoneScreen invite={INVITE} />);
    expect(celebrate).toHaveBeenCalledTimes(1);

    // Un re-rendu (changement de prop) ne doit pas relancer l'animation.
    rerender(<DoneScreen invite={{ ...INVITE, workspaceName: 'Autre' }} />);
    expect(celebrate).toHaveBeenCalledTimes(1);
  });

  it('remonte une célébration par affichage de l’écran', () => {
    const { unmount } = render(<DoneScreen invite={INVITE} />);
    unmount();
    render(<DoneScreen invite={INVITE} />);
    expect(celebrate).toHaveBeenCalledTimes(2);
  });
});
