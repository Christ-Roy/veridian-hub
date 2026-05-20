/**
 * Tests SignupForm — couvre les boutons OAuth (Google + Microsoft) et la
 * validation password côté client. Le but : verrouiller que les providers
 * Auth.js v5 sont appelés avec les bons IDs et que la mismatch password
 * est détectée avant tout appel réseau.
 *
 * Pas de test E2E ici (couvert par Playwright sur staging).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignupForm } from '@/components/auth/SignupForm';

const signInMock = vi.fn();
const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('SignupForm', () => {
  beforeEach(() => {
    signInMock.mockReset();
    routerPushMock.mockReset();
    routerRefreshMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('exporte un composant React nommé SignupForm', () => {
    expect(typeof SignupForm).toBe('function');
    expect(SignupForm.name).toBe('SignupForm');
  });

  it('affiche le bouton "Continuer avec Google" et appelle signIn("google") au clic', () => {
    render(<SignupForm />);
    const googleBtn = screen.getByRole('button', { name: /Continuer avec Google/i });
    expect(googleBtn).toBeTruthy();
    fireEvent.click(googleBtn);
    expect(signInMock).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
  });

  it('affiche le bouton "Continuer avec Microsoft" et appelle signIn("microsoft-entra-id") au clic', () => {
    render(<SignupForm />);
    const microsoftBtn = screen.getByRole('button', { name: /Continuer avec Microsoft/i });
    expect(microsoftBtn).toBeTruthy();
    fireEvent.click(microsoftBtn);
    expect(signInMock).toHaveBeenCalledWith('microsoft-entra-id', { callbackUrl: '/dashboard' });
  });

  it('refuse la soumission si les mots de passe ne correspondent pas', async () => {
    render(<SignupForm />);

    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const password = screen.getByLabelText('Mot de passe') as HTMLInputElement;
    const confirm = screen.getByLabelText('Confirmer le mot de passe') as HTMLInputElement;

    fireEvent.input(email, { target: { value: 'alice@example.com' } });
    fireEvent.input(password, { target: { value: 'hunter2hunter' } });
    fireEvent.input(confirm, { target: { value: 'different-password' } });

    const submit = screen.getByRole('button', { name: /Créer mon compte/i });
    fireEvent.click(submit);

    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Les mots de passe ne correspondent pas/i)).toBeTruthy();
  });

  it('cache les boutons OAuth quand allowOauth=false', () => {
    render(<SignupForm allowOauth={false} />);
    expect(screen.queryByRole('button', { name: /Continuer avec Google/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Continuer avec Microsoft/i })).toBeNull();
  });

  it("n'affiche pas LoginErrorBanner sans ?error= dans l'URL (default mock)", () => {
    render(<SignupForm />);
    // En l'absence de ?error= et d'erreur form, aucun role=alert ne doit exister.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('SignupForm avec ?error= dans searchParams', () => {
  beforeEach(() => {
    vi.resetModules();
    signInMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('affiche la bannière Configuration quand ?error=Configuration', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
      useSearchParams: () => new URLSearchParams('error=Configuration'),
    }));
    const { SignupForm: FreshSignupForm } = await import('@/components/auth/SignupForm');
    render(<FreshSignupForm />);
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-code')).toBe('Configuration');
    expect(alert.textContent).toMatch(/configuration/i);
  });
});
