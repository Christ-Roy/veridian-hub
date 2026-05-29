/**
 * Tests pour app/dashboard/components/CrmCard.tsx — card CRM Veridian (Twenty)
 * avec gating par tenant.
 *
 * Couvre le comportement de la prop `enabled` (flag TenantApp, défaut OFF) :
 *  - enabled=false (défaut) : badge "Bientôt", bouton "Bientôt disponible"
 *    désactivé, aucun appel d'activation possible
 *  - enabled=true + non configuré : bouton "Activer mon CRM" cliquable
 *  - enabled=true + configuré : badge "Actif", bouton "Ouvrir mon CRM"
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CrmCard } from '@/app/dashboard/components/CrmCard';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CrmCard — gating par tenant', () => {
  it('enabled=false (défaut) : badge "Bientôt" + bouton désactivé', () => {
    render(<CrmCard configured={false} />);
    expect(screen.getByText('Bientôt')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Bientôt disponible/i });
    expect(btn).toBeDisabled();
    // aucun bouton d'activation/ouverture exposé
    expect(screen.queryByRole('button', { name: /Activer mon CRM/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ouvrir mon CRM/i })).toBeNull();
  });

  it('enabled=false même si configured=true : reste gated (Bientôt)', () => {
    // Garde-fou : un ancien crmTenant ne doit pas court-circuiter le gating.
    render(<CrmCard configured={true} enabled={false} />);
    expect(screen.getByText('Bientôt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bientôt disponible/i })).toBeDisabled();
  });

  it('enabled=true + non configuré : bouton "Activer mon CRM" cliquable', () => {
    render(<CrmCard configured={false} enabled={true} />);
    const btn = screen.getByRole('button', { name: /Activer mon CRM/i });
    expect(btn).not.toBeDisabled();
    expect(screen.queryByText('Bientôt')).toBeNull();
  });

  it('enabled=true + configuré : badge "Actif" + bouton "Ouvrir mon CRM"', () => {
    render(<CrmCard configured={true} enabled={true} />);
    expect(screen.getByText('Actif')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Ouvrir mon CRM/i }),
    ).not.toBeDisabled();
  });
});
