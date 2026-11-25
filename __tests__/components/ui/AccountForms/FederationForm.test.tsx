/** Relier son compte d'organisation : rien à relier, rien à l'écran ; on part chez le fournisseur ; un refus se dit. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const t = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: t }));
vi.mock('@/lib/auth/reauth-redirect', () => ({ redirectIfReauthRequired: () => false }));

import FederationForm from '@/components/ui/AccountForms/FederationForm';

let liaisons: object[];
let reponse: { status: number; corps: object };
let posts: any[];
beforeEach(() => {
  vi.clearAllMocks();
  liaisons = [{ tenant_id: 'T', organisation: 'Client', fournisseur: 'Infomaniak', reliee: false }];
  reponse = { status: 200, corps: { ok: true, url: 'https://login.infomaniak.com/x' } };
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, i?: RequestInit) => {
    if (!i) return Response.json({ liaisons });
    posts.push(JSON.parse(String(i.body)));
    return Response.json(reponse.corps, { status: reponse.status });
  }));
});
describe('FederationForm', () => {
  it('relie : on part chez le fournisseur', async () => {
    const aller = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign: aller });
    render(<FederationForm />);
    fireEvent.click(await screen.findByRole('button', { name: 'Relier mon compte Infomaniak' }));
    await waitFor(() => expect(aller).toHaveBeenCalledWith('https://login.infomaniak.com/x'));
    expect(posts).toEqual([{ geste: 'relier', tenant_id: 'T' }]);
  });
  it('déjà reliée : délier', async () => {
    liaisons = [{ tenant_id: 'T', organisation: 'Client', fournisseur: 'Infomaniak', reliee: true }];
    reponse = { status: 200, corps: { ok: true } };
    render(<FederationForm />);
    fireEvent.click(await screen.findByRole('button', { name: 'Délier Infomaniak' }));
    await waitFor(() => expect(t.success).toHaveBeenCalledWith('Connexion déliée.'));
  });
  it('un refus se dit', async () => {
    reponse = { status: 403, corps: { error: 'session_federee' } };
    render(<FederationForm />);
    fireEvent.click(await screen.findByRole('button', { name: 'Relier mon compte Infomaniak' }));
    await waitFor(() => expect(t.error).toHaveBeenCalledWith('Connectez-vous avec votre mot de passe ou Google pour changer vos connexions.'));
  });
  it('aucune organisation à fournisseur : rien à l\'écran', async () => {
    liaisons = [];
    const { container } = render(<FederationForm />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
