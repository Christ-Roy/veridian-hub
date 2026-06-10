/**
 * Tests SignupForm — validation password côté client et intégration des
 * boutons OAuth (Google + Microsoft).
 *
 * Depuis le refacto Lot D, le bloc OAuth (SVG de marque + handlers signIn) est
 * extrait dans `<OAuthButtons>` (testé en isolation par OAuthButtons.test.tsx).
 * Les tests OAuth ci-dessous restent des tests d'INTÉGRATION assumés : ils
 * vérifient que SignupForm câble correctement OAuthButtons — bon callbackUrl,
 * gating `allowOauth`, footer "Se connecter" propre au signup.
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

  it('intègre OAuthButtons : "Continuer avec Google" appelle signIn("google")', () => {
    render(<SignupForm />);
    const googleBtn = screen.getByRole('button', { name: /Continuer avec Google/i });
    expect(googleBtn).toBeTruthy();
    fireEvent.click(googleBtn);
    expect(signInMock).toHaveBeenCalledWith('google', { callbackUrl: '/dashboard' });
  });

  it('intègre OAuthButtons : "Continuer avec Microsoft" appelle signIn("microsoft-entra-id")', () => {
    render(<SignupForm />);
    const microsoftBtn = screen.getByRole('button', { name: /Continuer avec Microsoft/i });
    expect(microsoftBtn).toBeTruthy();
    fireEvent.click(microsoftBtn);
    expect(signInMock).toHaveBeenCalledWith('microsoft-entra-id', { callbackUrl: '/dashboard' });
  });

  it('affiche le footer signup "Se connecter" pointant vers /login', () => {
    render(<SignupForm />);
    const loginLink = screen.getByRole('link', { name: /Se connecter/i });
    expect(loginLink.getAttribute('href')).toBe('/login');
  });

  it('signup réussi → redirige vers callbackUrl AVEC ?event=signup (tracking GA4 SignUp vs Login)', async () => {
    // Garde-fou du fix tunnel : sans `?event=signup`, auth-tracker.tsx compte
    // tout signup Credentials comme un Login GA4. La redirection post-signup
    // doit donc porter ce param.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'u1', email: 'bob@example.com' }) });
    signInMock.mockResolvedValue({ error: null });

    render(<SignupForm />);
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'bob@example.com' } });
    fireEvent.input(screen.getByLabelText('Mot de passe'), { target: { value: 'hunter2hunter' } });
    fireEvent.input(screen.getByLabelText('Confirmer le mot de passe'), { target: { value: 'hunter2hunter' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon compte/i }));

    // Attend la résolution des promises fetch + signIn (handler async).
    await vi.waitFor(() => expect(routerPushMock).toHaveBeenCalled());
    expect(routerPushMock).toHaveBeenCalledWith('/dashboard?event=signup');
  });

  it('signup réussi avec callbackUrl déjà porteur d\'un query param → séparateur & (URL valide)', async () => {
    vi.resetModules();
    vi.doMock('next/navigation', () => ({
      useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
      useSearchParams: () => new URLSearchParams('callbackUrl=/dashboard?tab=billing'),
    }));
    const { SignupForm: Fresh } = await import('@/components/auth/SignupForm');

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'u1', email: 'c@example.com' }) });
    signInMock.mockResolvedValue({ error: null });

    render(<Fresh />);
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'c@example.com' } });
    fireEvent.input(screen.getByLabelText('Mot de passe'), { target: { value: 'hunter2hunter' } });
    fireEvent.input(screen.getByLabelText('Confirmer le mot de passe'), { target: { value: 'hunter2hunter' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon compte/i }));

    await vi.waitFor(() => expect(routerPushMock).toHaveBeenCalled());
    expect(routerPushMock).toHaveBeenCalledWith('/dashboard?tab=billing&event=signup');
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

  it('intègre PasswordInput sur les 2 champs : masqués par défaut + 2 boutons toggle', () => {
    // Depuis la refonte DA, password ET confirmPassword utilisent PasswordInput
    // (champ + bouton œil). Garde-fou : les 2 champs sont bien des inputs
    // password masqués, et chacun a son bouton afficher/masquer.
    render(<SignupForm />);

    const pwd = document.querySelector('input[name="password"]') as HTMLInputElement;
    const confirm = document.querySelector(
      'input[name="confirmPassword"]',
    ) as HTMLInputElement;
    expect(pwd?.getAttribute('type')).toBe('password');
    expect(confirm?.getAttribute('type')).toBe('password');

    // 2 boutons toggle (un par champ), tous en mode "Afficher" au départ
    const toggles = screen.getAllByRole('button', { name: /Afficher le mot de passe/i });
    expect(toggles).toHaveLength(2);
  });

  it('cache OAuthButtons (et son footer) quand allowOauth=false', () => {
    render(<SignupForm allowOauth={false} />);
    expect(screen.queryByRole('button', { name: /Continuer avec Google/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Continuer avec Microsoft/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Se connecter/i })).toBeNull();
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
