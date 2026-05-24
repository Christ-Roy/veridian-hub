/**
 * Tests RTL pour `<RefillLeadsForm />` — form Client Component d'achat
 * refill leads Prospection.
 *
 * Vérifie :
 *   - calcul live du prix selon plan (freemium/pro/business) et quantité
 *   - sync bidirectionnel slider ↔ input number
 *   - clamp 1..MAX_LEADS_PER_REFILL_ORDER (100k)
 *   - label bouton dynamique avec quantité et prix formatés FR
 *   - disabled durant submit + label "Redirection vers le paiement…"
 *   - POST `/api/billing/refill-leads/checkout` avec body correct
 *   - redirection `window.location.href` sur réponse 200
 *   - toast erreur sur réponse 4xx (mapping codes d'erreur)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RefillLeadsForm } from '@/app/dashboard/refill-leads/RefillLeadsForm';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// `window.location.href = url` n'est pas patchable directement dans happy-dom.
// On mocke en remplaçant l'objet location par un proxy.
const originalLocation = window.location;
let mockHref = '';

beforeEach(() => {
  mockHref = '';
  // @ts-expect-error — override pour test
  delete window.location;
  // @ts-expect-error — override pour test
  window.location = {
    ...originalLocation,
    get href() {
      return mockHref;
    },
    set href(v: string) {
      mockHref = v;
    },
  };

  global.fetch = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error — restore
  window.location = originalLocation;
});

describe('<RefillLeadsForm>', () => {
  it('exporte un composant React', () => {
    expect(typeof RefillLeadsForm).toBe('function');
  });

  it('affiche la quantité par défaut (100) et calcule le prix freemium', () => {
    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="freemium" />);
    // 100 leads × 0,40€ (palier freemium 100..999) = 40,00€
    // Le prix apparaît dans le bloc résultat ET dans le label du bouton → getAllByText
    expect(screen.getAllByText(/40,00\s*€/).length).toBeGreaterThanOrEqual(1);
    // Tarif unitaire : 0,40€/lead
    expect(screen.getByText(/0,40\s*€\/lead/)).toBeInTheDocument();
  });

  it('met à jour le prix quand on change la quantité via le slider', () => {
    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="pro" />);
    const slider = screen.getByLabelText(/slider/i);
    fireEvent.change(slider, { target: { value: '500' } });
    // pro 100..999 = 0,25€ × 500 = 125,00€
    expect(screen.getAllByText(/125,00\s*€/).length).toBeGreaterThanOrEqual(1);
  });

  it('sync slider ↔ input number bidirectionnel', () => {
    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="business" />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '10000' } });
    // business 10000..49999 = 0,06€ × 10000 = 600,00€
    expect(screen.getAllByText(/600,00\s*€/).length).toBeGreaterThanOrEqual(1);
  });

  it('clamp la quantité à MAX_LEADS_PER_REFILL_ORDER (100k)', () => {
    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="business" />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '999999' } });
    // Doit clamp à 100000
    expect((input as HTMLInputElement).value).toBe('100000');
  });

  it('clamp la quantité à 1 si valeur < 1', () => {
    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="freemium" />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '0' } });
    expect((input as HTMLInputElement).value).toBe('1');
  });

  it('affiche un label de bouton avec quantité et prix formatés FR', () => {
    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="business" />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '1000' } });
    // business 1000..9999 = 0,10€ × 1000 = 100,00€
    const button = screen.getByRole('button', { name: /Acheter\s+1\s*000\s+leads/ });
    expect(button.textContent).toMatch(/100,00\s*€/);
  });

  it('POST sur /api/billing/refill-leads/checkout avec body correct + redirige', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/sess_xyz', sessionId: 'cs_xyz' }),
    });

    render(<RefillLeadsForm tenantId="tnt-42" prospectionPlan="pro" />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '250' } });
    const button = screen.getByRole('button', { name: /Acheter/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/refill-leads/checkout',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId: 'tnt-42', quantity: 250 }),
        }),
      );
    });

    await waitFor(() => {
      expect(mockHref).toBe('https://checkout.stripe.com/sess_xyz');
    });
  });

  it('désactive le bouton pendant submit et affiche label "Redirection…"', async () => {
    // Promise qui ne résout pas tout de suite pour observer l'état pending
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((res) => {
      resolveFetch = res;
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(fetchPromise);

    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="freemium" />);
    const button = screen.getByRole('button', { name: /Acheter/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole('button')).toBeDisabled();
      expect(screen.getByRole('button').textContent).toMatch(/Redirection/);
    });

    // Cleanup : résout la promise
    resolveFetch({ ok: true, json: async () => ({ url: 'https://checkout.stripe.com/x' }) });
  });

  it('affiche un toast erreur sur 4xx avec mapping de code', async () => {
    const { toast } = await import('sonner');
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'rate_limited' }),
    });

    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="freemium" />);
    fireEvent.click(screen.getByRole('button', { name: /Acheter/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Erreur',
        expect.objectContaining({
          description: expect.stringMatching(/Trop de tentatives/i),
        }),
      );
    });

    // Bouton réactivé après l'erreur (permet retry)
    await waitFor(() => {
      expect(screen.getByRole('button')).not.toBeDisabled();
    });
  });

  it('affiche un toast erreur réseau si fetch throw', async () => {
    const { toast } = await import('sonner');
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('NetworkDown'));

    render(<RefillLeadsForm tenantId="tnt-1" prospectionPlan="freemium" />);
    fireEvent.click(screen.getByRole('button', { name: /Acheter/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Erreur réseau',
        expect.objectContaining({ description: 'NetworkDown' }),
      );
    });
  });
});
