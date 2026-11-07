/**
 * D8 : `callbackUrl` de /login n'est suivi qu'après validation (`safeCallback`).
 * Un lien piégé `/login?callbackUrl=https://evil.example` ne doit pas sortir du Hub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from '@/components/auth/LoginForm';

const signInMock = vi.fn();
const routerPushMock = vi.fn();
const routerRefreshMock = vi.fn();
let search = '';
let fetchMock = vi.fn();

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
  useSearchParams: () => new URLSearchParams(search),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

async function connecter(callbackUrl: string | null) {
  search = callbackUrl === null ? '' : `callbackUrl=${encodeURIComponent(callbackUrl)}`;
  const { container, unmount } = render(<LoginForm />);
  const form = container.querySelector('form')!;
  const email = form.querySelector('input[name="email"]') as HTMLInputElement;
  const password = form.querySelector('input[name="password"]') as HTMLInputElement;
  email.value = 'a@b.fr';
  password.value = 'motdepasse';
  fireEvent.submit(form);
  await waitFor(() => expect(routerPushMock).toHaveBeenCalled());
  const cible = routerPushMock.mock.calls[0][0];
  unmount();
  return cible;
}

describe('LoginForm — callbackUrl validé (D8)', () => {
  beforeEach(() => {
    signInMock.mockReset().mockResolvedValue({ error: null });
    routerPushMock.mockReset();
    routerRefreshMock.mockReset();
    search = '';
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, mfa: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    ['https://evil.example', '/dashboard'],
    ['//evil.example', '/dashboard'],
    ['/\\evil.example', '/dashboard'],
    ['javascript:alert(1)', '/dashboard'],
  ])('callbackUrl %s → repli sur /dashboard', async (raw, attendu) => {
    expect(await connecter(raw)).toBe(attendu);
  });

  it('un chemin interne est respecté', async () => {
    expect(await connecter('/dashboard/settings?onglet=securite')).toBe(
      '/dashboard/settings?onglet=securite',
    );
  });

  it('sans callbackUrl : /dashboard', async () => {
    expect(await connecter(null)).toBe('/dashboard');
  });

  // D10 : Hub coupé ou erreur de configuration : message honnête, bouton rendu.
  it('signIn qui rejette : message « Connexion impossible », bouton réactivé', async () => {
    signInMock.mockRejectedValue(new Error('network'));
    const { container, findByText } = render(<LoginForm />);
    const form = container.querySelector('form')!;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'a@b.fr';
    (form.querySelector('input[name="password"]') as HTMLInputElement).value = 'motdepasse';
    fireEvent.submit(form);
    expect(await findByText(/Connexion impossible/)).toBeTruthy();
    const bouton = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(bouton.disabled).toBe(false);
  });

  it('erreur de configuration renvoyée par Auth.js : pas de faux « mot de passe invalide »', async () => {
    signInMock.mockResolvedValue({ error: 'Configuration' });
    const { container, findByText, queryByText } = render(<LoginForm />);
    const form = container.querySelector('form')!;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'a@b.fr';
    (form.querySelector('input[name="password"]') as HTMLInputElement).value = 'motdepasse';
    fireEvent.submit(form);
    expect(await findByText(/Connexion impossible/)).toBeTruthy();
    expect(queryByText(/mot de passe invalide/)).toBeNull();
  });

  // D3 : compte à double vérification → /auth/mfa avec la suite demandée, sans session ici.
  it('D3 : double vérification → /auth/mfa?next=… et aucun signIn', async () => {
    search = `callbackUrl=${encodeURIComponent('/dashboard/settings')}`;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mfa: true }), { status: 200 }));
    const { container, findByText: _ } = render(<LoginForm />);
    const form = container.querySelector('form')!;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'mfa@b.fr';
    (form.querySelector('input[name="password"]') as HTMLInputElement).value = 'motdepasse';
    fireEvent.submit(form);
    await waitFor(() => expect(routerPushMock).toHaveBeenCalled());
    expect(routerPushMock.mock.calls[0][0]).toBe(`/auth/mfa?next=${encodeURIComponent('/dashboard/settings')}`);
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('D3 : mauvais mot de passe au /start → message, pas de signIn', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 }));
    const { container, findByText } = render(<LoginForm />);
    const form = container.querySelector('form')!;
    (form.querySelector('input[name="email"]') as HTMLInputElement).value = 'a@b.fr';
    (form.querySelector('input[name="password"]') as HTMLInputElement).value = 'faux';
    fireEvent.submit(form);
    expect(await findByText(/Email ou mot de passe invalide/)).toBeTruthy();
    expect(signInMock).not.toHaveBeenCalled();
  });
});
