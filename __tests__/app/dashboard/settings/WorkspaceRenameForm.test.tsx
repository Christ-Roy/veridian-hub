/**
 * Tests RTL pour `<WorkspaceRenameForm />`.
 *
 * Couvre :
 *  - rend l'input pré-rempli avec currentName
 *  - bouton disabled tant que name == currentName
 *  - canRename=false → input ET bouton disabled + message destructive
 *  - PATCH appelé avec body { name } correctement (trimmed)
 *  - toast success + router.refresh() au succès
 *  - toast error sur 4xx avec mapping FR
 *  - disabled durant submit + label "Mise à jour…"
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkspaceRenameForm } from '@/app/dashboard/settings/WorkspaceRenameForm';

const routerRefreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefreshMock, push: vi.fn(), back: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  routerRefreshMock.mockReset();
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('<WorkspaceRenameForm>', () => {
  it('rend l\'input pré-rempli avec currentName', () => {
    render(
      <WorkspaceRenameForm
        workspaceId="wks-1"
        currentName="Mon Workspace"
        canRename={true}
      />,
    );
    const input = screen.getByLabelText(/nom du workspace/i) as HTMLInputElement;
    expect(input.value).toBe('Mon Workspace');
  });

  it('bouton disabled tant que name == currentName', () => {
    render(
      <WorkspaceRenameForm workspaceId="wks-1" currentName="X" canRename={true} />,
    );
    expect(screen.getByRole('button', { name: /renommer/i })).toBeDisabled();
  });

  it('bouton enabled quand name diffère et canRename', () => {
    render(
      <WorkspaceRenameForm workspaceId="wks-1" currentName="X" canRename={true} />,
    );
    const input = screen.getByLabelText(/nom du workspace/i);
    fireEvent.change(input, { target: { value: 'Y' } });
    expect(screen.getByRole('button', { name: /renommer/i })).not.toBeDisabled();
  });

  it('canRename=false → input + bouton disabled + message destructive', () => {
    render(
      <WorkspaceRenameForm
        workspaceId="wks-1"
        currentName="X"
        canRename={false}
      />,
    );
    expect(screen.getByLabelText(/nom du workspace/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /renommer/i })).toBeDisabled();
    expect(screen.getByText(/seul le propriétaire/i)).toBeInTheDocument();
  });

  it('PATCH appelé avec body name (trimmed côté UI aussi)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'wks-1', name: 'New Name' }),
    });
    render(
      <WorkspaceRenameForm workspaceId="wks-1" currentName="Old" canRename={true} />,
    );
    const input = screen.getByLabelText(/nom du workspace/i);
    fireEvent.change(input, { target: { value: '  New Name  ' } });
    fireEvent.click(screen.getByRole('button', { name: /renommer/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/workspace/wks-1/rename',
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Name' }),
        }),
      );
    });
  });

  it('toast success + router.refresh() au succès', async () => {
    const { toast } = await import('sonner');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'wks-1', name: 'New' }),
    });
    render(
      <WorkspaceRenameForm workspaceId="wks-1" currentName="Old" canRename={true} />,
    );
    fireEvent.change(screen.getByLabelText(/nom du workspace/i), {
      target: { value: 'New' },
    });
    fireEvent.click(screen.getByRole('button', { name: /renommer/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
      expect(routerRefreshMock).toHaveBeenCalled();
    });
  });

  it('toast error sur 403 avec mapping FR', async () => {
    const { toast } = await import('sonner');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden_not_owner' }),
    });
    render(
      <WorkspaceRenameForm workspaceId="wks-1" currentName="Old" canRename={true} />,
    );
    fireEvent.change(screen.getByLabelText(/nom du workspace/i), {
      target: { value: 'New' },
    });
    fireEvent.click(screen.getByRole('button', { name: /renommer/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Renommage échoué',
        expect.objectContaining({
          description: expect.stringMatching(/seul le propriétaire/i),
        }),
      );
    });
  });

  it('disabled durant submit + label dynamique "Mise à jour…"', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((res) => {
      resolveFetch = res;
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(fetchPromise);

    render(
      <WorkspaceRenameForm workspaceId="wks-1" currentName="Old" canRename={true} />,
    );
    fireEvent.change(screen.getByLabelText(/nom du workspace/i), {
      target: { value: 'New' },
    });
    fireEvent.click(screen.getByRole('button', { name: /renommer/i }));

    await waitFor(() => {
      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
      expect(btn.textContent).toMatch(/mise à jour/i);
    });

    resolveFetch({ ok: true, json: async () => ({ id: 'wks-1', name: 'New' }) });
  });
});
