/** Les autres adresses d'une personne (S1b) : demander, saisir le code, détacher ; un refus se dit, et rien ne laisse croire que l'adresse existe. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const t = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: t }));
vi.mock('@/lib/auth/reauth-redirect', () => ({ redirectIfReauthRequired: () => false }));

import AdressesForm from '@/components/ui/AccountForms/AdressesForm';

let secondaires: string[];
let reponse: { status: number; corps: object };
let posts: any[];
beforeEach(() => {
  vi.clearAllMocks();
  secondaires = ['pro@client.fr'];
  reponse = { status: 200, corps: { ok: true } };
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, i?: RequestInit) => {
    if (!i) return Response.json({ principale: 'j@x.fr', secondaires });
    posts.push(JSON.parse(String(i.body)));
    return Response.json(reponse.corps, { status: reponse.status });
  }));
});
const demander = async (adresse = 'Autre@Client.fr') => {
  render(<AdressesForm />);
  fireEvent.change(await screen.findByLabelText('Ajouter une adresse'), { target: { value: adresse } });
  fireEvent.submit(screen.getByRole('button', { name: 'Recevoir un code' }).closest('form')!);
};

describe('AdressesForm', () => {
  it('liste, demande un code, le confirme', async () => {
    await demander();
    expect(await screen.findByText('pro@client.fr')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Code reçu à autre@client.fr'), { target: { value: '012345' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Confirmer' }).closest('form')!);
    await waitFor(() => expect(posts).toEqual([{ geste: 'demander', email: 'autre@client.fr' }, { geste: 'confirmer', email: 'autre@client.fr', code: '012345' }]));
    expect(t.success.mock.calls[0][0]).toBe('Si cette adresse peut être ajoutée, un code y est parti.');
    expect(await screen.findByLabelText('Ajouter une adresse')).toBeTruthy();
  });
  it('un refus se dit, et le code reste à saisir', async () => {
    await demander();
    await screen.findByLabelText('Code reçu à autre@client.fr');
    reponse = { status: 400, corps: { error: 'code_invalide' } };
    fireEvent.submit(screen.getByRole('button', { name: 'Confirmer' }).closest('form')!);
    await waitFor(() => expect(t.error).toHaveBeenCalledWith('Code faux ou expiré. Redemandez-en un.'));
    expect(screen.getByLabelText('Code reçu à autre@client.fr')).toBeTruthy();
  });
  it('détache celle qu\'on choisit', async () => {
    render(<AdressesForm />);
    fireEvent.click(await screen.findByRole('button', { name: 'Détacher pro@client.fr' }));
    await waitFor(() => expect(posts).toEqual([{ geste: 'detacher', email: 'pro@client.fr' }]));
  });
});
