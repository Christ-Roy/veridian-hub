/**
 * Tests RTL pour `<InviteModal>` — modale d'invitation membre workspace.
 *
 * Couvre :
 *   - rendu du bouton "Inviter un membre"
 *   - ouverture de la modale au click
 *   - POST /api/workspace/invite avec email + role
 *   - feedback toast success
 *   - feedback toast erreur (API non-2xx)
 *   - validation : email vide → submit désactivé
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { InviteModal } from '@/components/workspace/InviteModal';

const WORKSPACE_ID = 'ws-123';

describe('<InviteModal>', () => {
  beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('affiche un bouton "Inviter un membre"', () => {
    render(<InviteModal workspaceId={WORKSPACE_ID} />);
    expect(
      screen.getByRole('button', { name: /Inviter un membre/i }),
    ).toBeInTheDocument();
  });

  it('ouvre la modale au click + affiche le form', () => {
    render(<InviteModal workspaceId={WORKSPACE_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Inviter un membre/i }));

    expect(screen.getByLabelText(/Adresse email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Rôle/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Envoyer l'invitation/i }),
    ).toBeInTheDocument();
  });

  it('POST /api/workspace/invite et toast success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, invitationId: 'inv-1' }),
    } as Response);

    render(<InviteModal workspaceId={WORKSPACE_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Inviter un membre/i }));

    const input = screen.getByLabelText(/Adresse email/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alice@example.com' } });
    fireEvent.click(
      screen.getByRole('button', { name: /Envoyer l'invitation/i }),
    );

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[0]).toBe('/api/workspace/invite');
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body).toEqual({
      workspaceId: WORKSPACE_ID,
      email: 'alice@example.com',
      role: 'MEMBER',
    });
  });

  it('API non-2xx → toast error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Cet email est déjà membre du workspace' }),
    } as Response);

    render(<InviteModal workspaceId={WORKSPACE_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Inviter un membre/i }));

    fireEvent.change(screen.getByLabelText(/Adresse email/i), {
      target: { value: 'bob@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Envoyer l'invitation/i }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Cet email est déjà membre du workspace',
      );
    });
  });

  it('réseau down → toast error réseau', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));

    render(<InviteModal workspaceId={WORKSPACE_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Inviter un membre/i }));

    fireEvent.change(screen.getByLabelText(/Adresse email/i), {
      target: { value: 'carol@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Envoyer l'invitation/i }),
    );

    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
  });

  it('submit désactivé si email vide', () => {
    render(<InviteModal workspaceId={WORKSPACE_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Inviter un membre/i }));

    const submit = screen.getByRole('button', {
      name: /Envoyer l'invitation/i,
    });
    expect(submit).toBeDisabled();
  });
});
