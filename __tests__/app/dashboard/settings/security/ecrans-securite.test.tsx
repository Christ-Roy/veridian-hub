import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const signOutMock = vi.fn(async () => {});
vi.mock('next-auth/react', () => ({ signOut: (...a: unknown[]) => signOutMock(...a) }));
const toastWarning = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { warning: (...a: unknown[]) => toastWarning(...a), error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { SecurityMfaToggle } from '@/app/dashboard/settings/security/SecurityMfaToggle';
import { SignOutEverywhere } from '@/app/dashboard/settings/security/SignOutEverywhere';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  signOutMock.mockClear();
  toastWarning.mockClear();
  toastError.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('SecurityMfaToggle', () => {
  it('sans mot de passe : pas de bouton Activer, et la raison est dite', () => {
    render(<SecurityMfaToggle initialEnabled={false} email="g@x.fr" hasPassword={false} />);
    expect(screen.queryByRole('button', { name: 'Activer' })).toBeNull();
    expect(screen.getByTestId('mfa-mot-de-passe-requis').textContent).toMatch(/mot de passe/);
  });

  it('avec mot de passe : le bouton Activer est là, pleine largeur au téléphone', () => {
    render(<SecurityMfaToggle initialEnabled={false} email="g@x.fr" hasPassword />);
    expect(screen.getByRole('button', { name: 'Activer' }).className).toContain('w-full');
  });

  it('refus serveur password_required : message français, pas de bascule', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'password_required' }) });
    render(<SecurityMfaToggle initialEnabled={false} email="g@x.fr" hasPassword />);
    fireEvent.click(screen.getByRole('button', { name: 'Activer' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/mot de passe/));
    expect(screen.getByText('Désactivée')).toBeTruthy();
  });

  it('coupure réseau : message français', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SecurityMfaToggle initialEnabled={false} email="g@x.fr" hasPassword />);
    fireEvent.click(screen.getByRole('button', { name: 'Activer' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Vérifiez votre réseau/));
    expect(document.body.textContent).not.toMatch(/Failed to fetch/);
  });
});

describe('SignOutEverywhere', () => {
  it('un clic ne coupe rien : une confirmation est demandée d’abord', async () => {
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByRole('button', { name: 'Se déconnecter partout' }));
    await screen.findByText('Se déconnecter partout ?');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('après confirmation, appelle la route puis signOut', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, apps_failed: [] }) });
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByRole('button', { name: 'Se déconnecter partout' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Me déconnecter partout' }));
    await waitFor(() => expect(signOutMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/account/sessions/revoke-all', { method: 'POST' });
  });

  it('nomme les apps qui n’ont pas confirmé la coupure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, apps_failed: ['prospection'] }) });
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByRole('button', { name: 'Se déconnecter partout' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Me déconnecter partout' }));
    await waitFor(() => expect(toastWarning).toHaveBeenCalled());
    expect(toastWarning.mock.calls[0][1].description).toContain('prospection');
    vi.useRealTimers();
  });
});
