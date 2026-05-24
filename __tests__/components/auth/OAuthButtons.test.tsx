/**
 * Tests OAuthButtons — composant partagé extrait de LoginForm + SignupForm.
 * Verrouille que les deux boutons OAuth (Google / Microsoft) appellent
 * `signIn` avec les bons provider IDs Auth.js v5 et le callbackUrl reçu en
 * prop, et que le footer optionnel (lien signup/login) est rendu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OAuthButtons, SignupLink, LoginLink } from '@/components/auth/OAuthButtons';

const signInMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('OAuthButtons', () => {
  beforeEach(() => {
    signInMock.mockReset();
  });

  it('appelle signIn("google") avec le callbackUrl reçu en prop', () => {
    render(<OAuthButtons callbackUrl="/dashboard" />);
    const googleBtn = screen.getByRole('button', { name: /Continuer avec Google/i });
    fireEvent.click(googleBtn);
    expect(signInMock).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
  });

  it('appelle signIn("microsoft-entra-id") avec le callbackUrl reçu en prop', () => {
    render(<OAuthButtons callbackUrl="/pricing?plan=pro" />);
    const msBtn = screen.getByRole('button', { name: /Continuer avec Microsoft/i });
    fireEvent.click(msBtn);
    expect(signInMock).toHaveBeenCalledWith('microsoft-entra-id', {
      callbackUrl: '/pricing?plan=pro',
    });
  });

  it('rend le footer quand fourni', () => {
    render(<OAuthButtons callbackUrl="/dashboard" footer={<span>mon footer</span>} />);
    expect(screen.getByText('mon footer')).toBeTruthy();
  });

  it('ne rend pas de footer quand non fourni', () => {
    render(<OAuthButtons callbackUrl="/dashboard" />);
    expect(screen.queryByText(/Déjà un compte/i)).toBeNull();
    expect(screen.queryByText(/Pas encore de compte/i)).toBeNull();
  });

  // Migration 2026-05-24 (commit OAuthButtons → provider-icons) :
  // les SVG inline ont été remplacés par les composants `<GoogleIcon />`
  // et `<MicrosoftIcon />`. Ces tests verrouillent qu'au moins UN <svg>
  // par bouton est rendu (les icones du module partagé), ce qui prévient
  // un futur "oubli d'icône" lors d'un refactor.
  it('rend une icône SVG (Google) à gauche du label "Continuer avec Google"', () => {
    const { container } = render(<OAuthButtons callbackUrl="/dashboard" />);
    const googleBtn = screen.getByRole('button', { name: /Continuer avec Google/i });
    const svgs = googleBtn.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('rend une icône SVG (Microsoft) à gauche du label "Continuer avec Microsoft"', () => {
    const { container } = render(<OAuthButtons callbackUrl="/dashboard" />);
    const msBtn = screen.getByRole('button', { name: /Continuer avec Microsoft/i });
    const svgs = msBtn.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  // Garantit qu'on n'a pas régressé sur l'a11y : les icônes décoratives
  // doivent être ignorées par les lecteurs d'écran (le label texte porte le sens).
  it('les icônes provider sont aria-hidden (décoratives, le label texte porte le sens)', () => {
    render(<OAuthButtons callbackUrl="/dashboard" />);
    const allSvgs = document.querySelectorAll('button svg');
    expect(allSvgs.length).toBeGreaterThanOrEqual(2);
    allSvgs.forEach((svg) => {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    });
  });
});

describe('SignupLink / LoginLink', () => {
  it('SignupLink pointe vers /signup', () => {
    render(<SignupLink />);
    const link = screen.getByRole('link', { name: /Créer un compte/i });
    expect(link.getAttribute('href')).toBe('/signup');
  });

  it('LoginLink pointe vers /login', () => {
    render(<LoginLink />);
    const link = screen.getByRole('link', { name: /Se connecter/i });
    expect(link.getAttribute('href')).toBe('/login');
  });
});
