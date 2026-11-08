/** Coupure réseau : message français utile, jamais « Failed to fetch », bouton réactivé. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), dismiss: vi.fn() } }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn(), signIn: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }));

import PasswordForm from '@/components/ui/AccountForms/PasswordForm';
import EmailForm from '@/components/ui/AccountForms/EmailForm';
import { SignupForm } from '@/components/auth/SignupForm';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  toastError.mockClear();
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetchMock);
});

describe('PasswordForm', () => {
  it('coupure réseau : message français, bouton réactivé', async () => {
    render(<PasswordForm />);
    fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: 'motdepasse1' } });
    fireEvent.change(screen.getByLabelText('Confirmer le nouveau mot de passe'), { target: { value: 'motdepasse1' } });
    const bouton = screen.getByRole('button', { name: /Mettre à jour/ });
    fireEvent.click(bouton);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Vérifiez votre réseau/));
    expect(document.body.textContent).not.toMatch(/Failed to fetch/);
    expect((screen.getByRole('button', { name: /Mettre à jour/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('7 caractères : le message dit la règle 8 à 72', async () => {
    render(<PasswordForm />);
    fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: 'abcdefg' } });
    fireEvent.change(screen.getByLabelText('Confirmer le nouveau mot de passe'), { target: { value: 'abcdefg' } });
    fireEvent.click(screen.getByRole('button', { name: /Mettre à jour/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/au moins 8/));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/8 et 72/);
  });
});

describe('EmailForm', () => {
  it('coupure réseau : toast français', async () => {
    render(<EmailForm userEmail="a@x.fr" />);
    fireEvent.change(screen.getByPlaceholderText('Votre email'), { target: { value: 'b@x.fr' } });
    fireEvent.submit(document.getElementById('emailForm')!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toMatch(/Vérifiez votre réseau/);
  });
});

describe('SignupForm', () => {
  it('coupure réseau : message français, bouton réactivé', async () => {
    const { container } = render(<SignupForm />);
    fireEvent.change(container.querySelector('#email')!, { target: { value: 'a@x.fr' } });
    fireEvent.change(container.querySelector('#password')!, { target: { value: 'motdepasse1' } });
    fireEvent.change(container.querySelector('#confirmPassword')!, { target: { value: 'motdepasse1' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(screen.getAllByRole('alert').some((a) => /Vérifiez votre réseau/.test(a.textContent ?? ''))).toBe(true));
    expect(document.body.textContent).not.toMatch(/Failed to fetch/);
    expect((screen.getByRole('button', { name: /Créer mon compte/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
