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
});
