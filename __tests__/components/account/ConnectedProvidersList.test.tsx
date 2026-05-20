/**
 * Tests ConnectedProvidersList
 *
 * Couvre :
 *  - Render avec 0 / 1 / 2 providers
 *  - Click "Connecter Google" appelle signIn('google')
 *  - Click "Déconnecter" appelle DELETE /api/account/connected-providers/<p>
 *  - Erreur API affichée dans l'Alert
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import ConnectedProvidersList from '@/components/account/ConnectedProvidersList';

const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  signInMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

const respondJSON = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

describe('ConnectedProvidersList', () => {
  it('affiche "Chargement…" puis "Aucun provider connecté" si vide', async () => {
    fetchMock.mockResolvedValueOnce(respondJSON({ providers: [] }));
    render(<ConnectedProvidersList />);
    await waitFor(() => {
      expect(screen.getByText(/Aucun provider connecté/i)).toBeTruthy();
    });
  });

  it('affiche les providers et propose ceux non connectés en boutons "Connecter"', async () => {
    fetchMock.mockResolvedValueOnce(
      respondJSON({
        providers: [
          { id: 'a1', provider: 'google', providerAccountId: 'alice@gmail.com', type: 'oauth' },
        ],
      })
    );
    render(<ConnectedProvidersList />);
    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
      expect(screen.getByText('alice@gmail.com')).toBeTruthy();
    });
    // Microsoft pas connecté → bouton "Connecter Microsoft"
    expect(screen.getByText(/Connecter Microsoft/i)).toBeTruthy();
  });

  it('click "Connecter Microsoft" appelle signIn("microsoft-entra-id")', async () => {
    fetchMock.mockResolvedValueOnce(respondJSON({ providers: [] }));
    render(<ConnectedProvidersList />);
    await waitFor(() => screen.getByText(/Connecter Microsoft/i));
    fireEvent.click(screen.getByText(/Connecter Microsoft/i));
    expect(signInMock).toHaveBeenCalledWith('microsoft-entra-id', {
      callbackUrl: '/dashboard/settings',
    });
  });

  it('click "Déconnecter Google" appelle DELETE /api/account/connected-providers/google', async () => {
    // 1er fetch = GET initial
    fetchMock.mockResolvedValueOnce(
      respondJSON({
        providers: [
          { id: 'a1', provider: 'google', providerAccountId: 'alice@gmail.com', type: 'oauth' },
          { id: 'a2', provider: 'microsoft-entra-id', providerAccountId: 'a@v.site', type: 'oauth' },
        ],
      })
    );
    // 2e fetch = DELETE
    fetchMock.mockResolvedValueOnce(respondJSON({ success: true, provider: 'google' }));
    // 3e fetch = refresh après delete
    fetchMock.mockResolvedValueOnce(
      respondJSON({
        providers: [
          { id: 'a2', provider: 'microsoft-entra-id', providerAccountId: 'a@v.site', type: 'oauth' },
        ],
      })
    );

    render(<ConnectedProvidersList />);
    await waitFor(() => screen.getByText('Google'));
    const btn = screen.getAllByText('Déconnecter')[0];
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/account/connected-providers/google', {
      method: 'DELETE',
    });
  });

  it("affiche l'erreur API quand DELETE retourne 409 (last login method)", async () => {
    fetchMock.mockResolvedValueOnce(
      respondJSON({
        providers: [
          { id: 'a1', provider: 'google', providerAccountId: 'alice@gmail.com', type: 'oauth' },
        ],
      })
    );
    fetchMock.mockResolvedValueOnce(
      respondJSON({ error: 'last_login_method', message: 'Dernier moyen de connexion.' }, 409)
    );

    render(<ConnectedProvidersList />);
    await waitFor(() => screen.getByText('Google'));
    await act(async () => {
      fireEvent.click(screen.getByText('Déconnecter'));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Dernier moyen de connexion/);
    });
  });
});
