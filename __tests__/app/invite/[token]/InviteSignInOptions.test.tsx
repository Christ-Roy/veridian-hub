/**
 * Tests RTL pour `<InviteSignInOptions />` — bloc de sign-in affiché sur
 * `/invite/[token]` quand l'invitee n'est pas encore loggué.
 *
 * Vérifie :
 *   - allowOauth=true → Google + Microsoft visibles
 *   - allowOauth=false → boutons OAuth absents (gate staging Tailscale)
 *   - lien "Créer un compte par email" inclut le token + callbackUrl
 *   - lien "J'ai déjà un compte" pointe sur /login avec callbackUrl
 *   - email invitee pré-renseigné dans le href signup
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

import { InviteSignInOptions } from '@/app/invite/[token]/InviteSignInOptions';

const TOKEN = 'b'.repeat(64);
const RETURN_TO = `/invite/${TOKEN}`;

describe('<InviteSignInOptions>', () => {
  it('affiche Google + Microsoft quand allowOauth=true', () => {
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={true}
      />,
    );

    expect(screen.getByTestId('invite-signin-google')).toBeInTheDocument();
    expect(screen.getByTestId('invite-signin-microsoft')).toBeInTheDocument();
  });

  it('cache Google + Microsoft quand allowOauth=false (staging Tailscale)', () => {
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={false}
      />,
    );

    expect(screen.queryByTestId('invite-signin-google')).toBeNull();
    expect(screen.queryByTestId('invite-signin-microsoft')).toBeNull();
  });

  it('toujours afficher signup email + login existant (toutes les variantes)', () => {
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={false}
      />,
    );

    expect(screen.getByTestId('invite-signup-email')).toBeInTheDocument();
    expect(screen.getByTestId('invite-login-existing')).toBeInTheDocument();
  });

  it('signup href encode token + callbackUrl + email pré-rempli', () => {
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        inviteeEmail="alice@example.com"
        allowOauth={true}
      />,
    );

    // Button asChild rend directement le Link (anchor), pas un wrapper
    const signupLink = screen.getByTestId('invite-signup-email');
    const href = signupLink.getAttribute('href');
    expect(href).not.toBeNull();
    expect(href).toContain(`invite=${TOKEN}`);
    expect(href).toContain(
      `callbackUrl=${encodeURIComponent(RETURN_TO)}`,
    );
    expect(href).toContain(
      `email=${encodeURIComponent('alice@example.com')}`,
    );
  });

  it("signup href sans email quand inviteeEmail absent", () => {
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={true}
      />,
    );

    const signupLink = screen.getByTestId('invite-signup-email');
    const href = signupLink.getAttribute('href') ?? '';
    expect(href).not.toContain('email=');
  });

  it("login href pointe sur /login avec callbackUrl=returnTo", () => {
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={true}
      />,
    );

    const loginLink = screen.getByTestId('invite-login-existing');
    expect(loginLink.getAttribute('href')).toBe(
      `/login?callbackUrl=${encodeURIComponent(RETURN_TO)}`,
    );
  });

  it('click Google → signIn("google", {callbackUrl})', () => {
    signInMock.mockReset();
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={true}
      />,
    );

    fireEvent.click(screen.getByTestId('invite-signin-google'));
    expect(signInMock).toHaveBeenCalledWith('google', {
      callbackUrl: RETURN_TO,
    });
  });

  it('click Microsoft → signIn("microsoft-entra-id", {callbackUrl})', () => {
    signInMock.mockReset();
    render(
      <InviteSignInOptions
        token={TOKEN}
        returnTo={RETURN_TO}
        allowOauth={true}
      />,
    );

    fireEvent.click(screen.getByTestId('invite-signin-microsoft'));
    expect(signInMock).toHaveBeenCalledWith('microsoft-entra-id', {
      callbackUrl: RETURN_TO,
    });
  });
});
