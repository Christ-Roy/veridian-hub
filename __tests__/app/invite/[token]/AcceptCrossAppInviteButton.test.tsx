/**
 * Tests RTL pour `<AcceptCrossAppInviteButton />` — gère les 3 réponses
 * downstream du POST /api/invitations/[token]/accept :
 *
 *   - 200 OK   downstream_call=completed → redirect vers redirect_url
 *   - 202 Acc  downstream_call=pending   → message d'attente + bouton retry
 *   - 502 BG   downstream_call=error     → message d'erreur + bouton retry
 *
 * Vérifie également les codes business côté error (workspace_suspended,
 * role_conflict, user_not_provisioned, expired, etc.) pour s'assurer que
 * l'UI affiche un message exploitable plutôt qu'un brut "HTTP 502".
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn() }),
}));

import { AcceptCrossAppInviteButton } from '@/app/invite/[token]/AcceptCrossAppInviteButton';

const TOKEN = 'a'.repeat(64);

function mockFetch(response: Partial<Response> & { jsonValue: unknown }) {
  const fakeRes = {
    status: response.status ?? 200,
    ok: (response.status ?? 200) < 400,
    json: async () => response.jsonValue,
  } as Response;
  return vi.fn().mockResolvedValue(fakeRes);
}

describe('<AcceptCrossAppInviteButton>', () => {
  beforeEach(() => {
    routerPush.mockReset();
    // Stub window.location.href setter to avoid jsdom navigation errors.
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: '' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('affiche un bouton Accepter par défaut', () => {
    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    expect(screen.getByTestId('invite-accept-button')).toBeInTheDocument();
    expect(screen.getByText(/Accepter l'invitation/i)).toBeInTheDocument();
  });

  it('200 completed : déclenche le redirect (external URL → window.location)', async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      jsonValue: {
        ok: true,
        downstream_call: 'completed',
        redirect_url: 'https://notifuse.example.com/auto-login?token=xyz',
      },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(window.location.href).toBe(
        'https://notifuse.example.com/auto-login?token=xyz',
      );
    });
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('200 completed : redirect URL interne → router.push', async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      jsonValue: {
        ok: true,
        downstream_call: 'completed',
        redirect_url: '/dashboard',
      },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('202 pending : affiche le message "en cours d\'attribution" + bouton Réessayer', async () => {
    globalThis.fetch = mockFetch({
      status: 202,
      jsonValue: {
        ok: true,
        downstream_call: 'pending',
        redirect_url: 'https://prospection.example.com',
      },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Prospection" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByTestId('invite-pending')).toBeInTheDocument();
    });
    expect(screen.getByText(/en cours d'attribution/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Réessayer/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ouvrir Prospection/i })).toBeInTheDocument();
  });

  it('502 error workspace_suspended : affiche message business explicite', async () => {
    globalThis.fetch = mockFetch({
      status: 502,
      jsonValue: {
        ok: false,
        downstream_call: 'error',
        error: 'workspace_suspended',
      },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByTestId('invite-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/workspace est actuellement suspendu/i)).toBeInTheDocument();
    expect(screen.getByText(/Code : workspace_suspended/i)).toBeInTheDocument();
  });

  it('502 error role_conflict : affiche message rôle', async () => {
    globalThis.fetch = mockFetch({
      status: 502,
      jsonValue: {
        ok: false,
        downstream_call: 'error',
        error: 'role_conflict',
      },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByTestId('invite-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/rôle différent sur ce workspace/i)).toBeInTheDocument();
  });

  it('409 user_not_provisioned : message dédié', async () => {
    globalThis.fetch = mockFetch({
      status: 409,
      jsonValue: { error: 'user_not_provisioned' },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByTestId('invite-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/pas encore provisionné/i)).toBeInTheDocument();
  });

  it('410 expired : message expiration', async () => {
    globalThis.fetch = mockFetch({
      status: 410,
      jsonValue: { error: 'expired' },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByText(/lien d'invitation a expiré/i)).toBeInTheDocument();
    });
  });

  it('429 rate_limited : message rate limit', async () => {
    globalThis.fetch = mockFetch({
      status: 429,
      jsonValue: { error: 'rate_limited' },
    });

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByText(/Trop de tentatives/i)).toBeInTheDocument();
    });
  });

  it('réseau down : affiche erreur réseau générique', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByText(/Erreur réseau/i)).toBeInTheDocument();
    });
  });

  it('pending → retry réussit (completed) → redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 202,
        ok: false,
        json: async () => ({
          ok: true,
          downstream_call: 'pending',
          redirect_url: 'https://app.example.com',
        }),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          downstream_call: 'completed',
          redirect_url: 'https://app.example.com/auto-login',
        }),
      } as Response);
    globalThis.fetch = fetchMock;

    render(<AcceptCrossAppInviteButton token={TOKEN} appLabel="Notifuse" />);
    fireEvent.click(screen.getByTestId('invite-accept-button'));

    await waitFor(() => {
      expect(screen.getByTestId('invite-pending')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Réessayer/i }));

    await waitFor(() => {
      expect(window.location.href).toBe('https://app.example.com/auto-login');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
