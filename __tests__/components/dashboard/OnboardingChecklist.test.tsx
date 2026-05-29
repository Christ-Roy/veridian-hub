/**
 * Tests OnboardingChecklist — repère d'accueil "premier pas" du dashboard.
 *
 * Verrouille l'heuristique de complétion : le repère disparaît dès la
 * première app démarrée et NON au premier trial (régression de l'ancien
 * `<Alert>` gardé sur `!tenant`). Verrouille aussi le titre dynamique et
 * l'état coché/décoché de chaque item.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OnboardingChecklist } from '@/app/dashboard/components/OnboardingChecklist';

describe('OnboardingChecklist', () => {
  it('ne rend rien une fois une app démarrée (onboarding abouti)', () => {
    const { container } = render(
      <OnboardingChecklist
        workspaceName="Acme"
        hasStartedApp
        hasInvitedMember={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('reste visible tant qu\'aucune app n\'est démarrée', () => {
    render(
      <OnboardingChecklist
        workspaceName="Acme"
        hasStartedApp={false}
        hasInvitedMember={false}
      />,
    );
    expect(screen.getByText(/Bienvenue sur Acme/)).toBeTruthy();
  });

  it('affiche le nom réel du workspace dans le titre', () => {
    render(
      <OnboardingChecklist
        workspaceName="Workspace de Robert"
        hasStartedApp={false}
        hasInvitedMember={false}
      />,
    );
    expect(screen.getByText(/Workspace de Robert/)).toBeTruthy();
  });

  it('liste les 3 étapes d\'onboarding', () => {
    render(
      <OnboardingChecklist
        workspaceName="Acme"
        hasStartedApp={false}
        hasInvitedMember={false}
      />,
    );
    expect(screen.getByText('Activez votre premier outil')).toBeTruthy();
    expect(
      screen.getByText('Invitez un membre dans votre espace'),
    ).toBeTruthy();
    expect(
      screen.getByText('Personnalisez le nom de votre espace'),
    ).toBeTruthy();
  });

  it('barre l\'étape "invite un membre" quand le workspace a plus d\'un membre', () => {
    render(
      <OnboardingChecklist
        workspaceName="Acme"
        hasStartedApp={false}
        hasInvitedMember
      />,
    );
    const item = screen.getByText('Invitez un membre dans votre espace');
    expect(item.className).toContain('line-through');
  });

  it('ne barre pas "invite un membre" quand le workspace est solo', () => {
    render(
      <OnboardingChecklist
        workspaceName="Acme"
        hasStartedApp={false}
        hasInvitedMember={false}
      />,
    );
    const item = screen.getByText('Invitez un membre dans votre espace');
    expect(item.className).not.toContain('line-through');
  });

  it('propose un lien vers les paramètres pour renommer le workspace', () => {
    render(
      <OnboardingChecklist
        workspaceName="Acme"
        hasStartedApp={false}
        hasInvitedMember={false}
      />,
    );
    const link = screen.getByRole('link', { name: 'paramètres' });
    expect(link.getAttribute('href')).toBe('/dashboard/settings');
  });
});
