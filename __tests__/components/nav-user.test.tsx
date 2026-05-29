/**
 * Tests pour components/nav-user.tsx — le menu utilisateur en pied de
 * sidebar (avatar + dropdown).
 *
 * Vérifie :
 *  - le trigger affiche nom + email de l'utilisateur
 *  - les initiales sont dérivées du nom
 *  - à l'ouverture, le menu rend les entrées en français
 *    (Mon compte, Facturation, Notifications, Déconnexion)
 *
 * NavUser consomme usePathname (next/navigation), signOut (next-auth/react)
 * et le contexte sidebar — les deux premiers sont mockés, le 3e fourni via
 * SidebarProvider.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

const signOutMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

import { NavUser } from '@/components/nav-user';
import { SidebarProvider } from '@/components/ui/sidebar';

const USER = {
  name: 'Alice Martin',
  email: 'alice@example.com',
  avatar: '/avatars/default.svg',
};

function renderNavUser() {
  return render(
    <SidebarProvider>
      <NavUser user={USER} />
    </SidebarProvider>,
  );
}

describe('NavUser', () => {
  it('affiche le nom et l\'email de l\'utilisateur sur le trigger', () => {
    renderNavUser();
    // Nom + email sont rendus dans le bouton trigger (avant ouverture).
    expect(screen.getAllByText('Alice Martin').length).toBeGreaterThan(0);
    expect(screen.getAllByText('alice@example.com').length).toBeGreaterThan(0);
  });

  it('dérive les initiales du nom (Alice Martin → AM)', () => {
    renderNavUser();
    expect(screen.getAllByText('AM').length).toBeGreaterThan(0);
  });

  it('l\'avatar n\'est plus grisé (grayscale retiré — refonte DA 2026-05-29)', () => {
    const { container } = renderNavUser();
    // Le commit DA a retiré la classe `grayscale` de l'Avatar du trigger.
    const grayscaled = container.querySelector('.grayscale');
    expect(grayscaled).toBeNull();
  });

  /**
   * Ouvre le DropdownMenu Radix. Le trigger réagit à pointerdown/pointerup
   * (pas au `click` synthétique seul) — c'est le geste que Radix écoute.
   */
  function openMenu() {
    const trigger = screen.getByRole('button');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(trigger, { button: 0 });
  }

  it('ouvre le menu et rend les entrées en français', () => {
    renderNavUser();
    openMenu();

    expect(screen.getByText('Mon compte')).toBeInTheDocument();
    expect(screen.getByText('Facturation')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Déconnexion')).toBeInTheDocument();
  });

  it('le clic sur "Déconnexion" déclenche signOut', () => {
    signOutMock.mockClear();
    renderNavUser();
    openMenu();
    fireEvent.click(screen.getByText('Déconnexion'));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
