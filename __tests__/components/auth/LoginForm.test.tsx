/**
 * Tests LoginForm — couvre les boutons OAuth (Google + Microsoft) et le
 * fallback Credentials (email/password). Le but : verrouiller que les
 * providers Auth.js v5 sont appelés avec les bons IDs côté next-auth/react,
 * et que le formulaire email/password reste opérationnel.
 *
 * Pas de test E2E ici (couvert par Playwright sur staging). On valide
 * uniquement le câblage React → next-auth signIn().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginForm } from '@/components/auth/LoginForm';

const signInMock = vi.fn();
const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();

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

describe('LoginForm', () => {
  beforeEach(() => {
    signInMock.mockReset();
    routerPushMock.mockReset();
    routerRefreshMock.mockReset();
  });

  it('exporte un composant React nommé LoginForm', () => {
    expect(typeof LoginForm).toBe('function');
    expect(LoginForm.name).toBe('LoginForm');
  });

  it('affiche le bouton "Continuer avec Google" et appelle signIn("google") au clic', () => {
    render(<LoginForm />);
    const googleBtn = screen.getByRole('button', { name: /Continuer avec Google/i });
    expect(googleBtn).toBeTruthy();
    fireEvent.click(googleBtn);
    expect(signInMock).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
  });

  it('affiche le bouton "Continuer avec Microsoft" et appelle signIn("microsoft-entra-id") au clic', () => {
    render(<LoginForm />);
    const microsoftBtn = screen.getByRole('button', { name: /Continuer avec Microsoft/i });
    expect(microsoftBtn).toBeTruthy();
    fireEvent.click(microsoftBtn);
    expect(signInMock).toHaveBeenCalledWith('microsoft-entra-id', { callbackUrl: '/dashboard' });
  });

  it('appelle signIn("credentials") avec email + password à la soumission du formulaire', async () => {
    signInMock.mockResolvedValueOnce({ ok: true, error: undefined });
    render(<LoginForm />);

    const emailInput = screen.getByLabelText(/Email/i) as HTMLInputElement;
    const passwordInput = screen.getByLabelText(/Mot de passe/i) as HTMLInputElement;
    emailInput.value = 'alice@example.com';
    fireEvent.input(emailInput, { target: { value: 'alice@example.com' } });
    fireEvent.input(passwordInput, { target: { value: 'hunter2hunter' } });

    const submit = screen.getByRole('button', { name: /Se connecter/i });
    fireEvent.click(submit);

    await Promise.resolve();
    await Promise.resolve();

    expect(signInMock).toHaveBeenCalledWith('credentials', expect.objectContaining({
      email: 'alice@example.com',
      password: 'hunter2hunter',
      redirect: false,
    }));
  });

  it('cache les boutons OAuth quand allowOauth=false', () => {
    render(<LoginForm allowOauth={false} />);
    expect(screen.queryByRole('button', { name: /Continuer avec Google/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Continuer avec Microsoft/i })).toBeNull();
  });

  it("n'affiche pas LoginErrorBanner sans ?error= dans l'URL (default mock)", () => {
    render(<LoginForm />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LoginForm avec ?error= dans searchParams', () => {
  // Mock spécifique : URLSearchParams pré-rempli avec ?error=AccessDenied
  // pour vérifier que LoginForm intègre bien LoginErrorBanner et que celle-ci
  // pick up le param.
  beforeEach(() => {
    vi.resetModules();
    signInMock.mockReset();
    routerPushMock.mockReset();
  });

  it('affiche la bannière AccessDenied quand ?error=AccessDenied', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
      useSearchParams: () => new URLSearchParams('error=AccessDenied'),
    }));
    const { LoginForm: FreshLoginForm } = await import('@/components/auth/LoginForm');
    render(<FreshLoginForm />);
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-code')).toBe('AccessDenied');
    expect(alert.textContent).toMatch(/annulée/i);
  });

  it('affiche la bannière OAuthAccountNotLinked quand ?error=OAuthAccountNotLinked', async () => {
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
      useSearchParams: () => new URLSearchParams('error=OAuthAccountNotLinked'),
    }));
    const { LoginForm: FreshLoginForm } = await import('@/components/auth/LoginForm');
    render(<FreshLoginForm />);
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-error-code')).toBe('OAuthAccountNotLinked');
    expect(alert.textContent).toMatch(/déjà lié/i);
  });
});
