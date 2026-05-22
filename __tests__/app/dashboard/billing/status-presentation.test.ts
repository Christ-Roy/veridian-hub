/**
 * Tests du module de présentation des états de subscription billing.
 * Verrouille le mapping statut Stripe → badge / alerte de tête de page :
 *   - past_due / unpaid  → alerte d'urgence + CTA portal
 *   - canceled / expired → alerte réactivation + CTA pricing
 *   - active / trialing  → aucune alerte
 */

import { describe, it, expect } from 'vitest';
import {
  getStatusBadge,
  getStatusAlert,
  hasUsableAccess,
} from '@/app/dashboard/billing/status-presentation';

describe('getStatusBadge', () => {
  it('mappe chaque statut connu sur un badge FR', () => {
    expect(getStatusBadge('active')).toEqual({
      label: 'Actif',
      variant: 'success',
    });
    expect(getStatusBadge('trialing')).toEqual({
      label: 'Essai en cours',
      variant: 'info',
    });
    expect(getStatusBadge('past_due')).toEqual({
      label: 'Paiement en échec',
      variant: 'warning',
    });
    expect(getStatusBadge('canceled')).toEqual({
      label: 'Annulé',
      variant: 'outline',
    });
    expect(getStatusBadge('unpaid')).toEqual({
      label: 'Impayé',
      variant: 'destructive',
    });
  });

  it('retombe sur "Incomplet" pour un statut inconnu (fail-safe)', () => {
    expect(getStatusBadge('totally_unknown')).toEqual({
      label: 'Incomplet',
      variant: 'outline',
    });
  });
});

describe('getStatusAlert', () => {
  it('renvoie une alerte d’urgence portal pour past_due', () => {
    const alert = getStatusAlert('past_due');
    expect(alert).not.toBeNull();
    expect(alert?.variant).toBe('destructive');
    expect(alert?.cta).toBe('portal');
    expect(alert?.ctaLabel).toContain('carte');
  });

  it('traite unpaid comme past_due (urgence portal)', () => {
    const alert = getStatusAlert('unpaid');
    expect(alert?.cta).toBe('portal');
    expect(alert?.variant).toBe('destructive');
  });

  it('renvoie une alerte de réactivation pricing pour canceled', () => {
    const alert = getStatusAlert('canceled');
    expect(alert).not.toBeNull();
    expect(alert?.variant).toBe('warning');
    expect(alert?.cta).toBe('pricing');
    expect(alert?.ctaLabel).toContain('Réactiver');
  });

  it('traite incomplete_expired comme une annulation', () => {
    const alert = getStatusAlert('incomplete_expired');
    expect(alert?.cta).toBe('pricing');
  });

  it('ne renvoie aucune alerte pour les états sains', () => {
    expect(getStatusAlert('active')).toBeNull();
    expect(getStatusAlert('trialing')).toBeNull();
    expect(getStatusAlert('incomplete')).toBeNull();
  });

  it('ne renvoie aucune alerte pour un statut inconnu', () => {
    expect(getStatusAlert('weird_status')).toBeNull();
  });
});

describe('hasUsableAccess', () => {
  it('vrai pour trialing / active / past_due', () => {
    expect(hasUsableAccess('trialing')).toBe(true);
    expect(hasUsableAccess('active')).toBe(true);
    expect(hasUsableAccess('past_due')).toBe(true);
  });

  it('faux pour canceled / unpaid / incomplete', () => {
    expect(hasUsableAccess('canceled')).toBe(false);
    expect(hasUsableAccess('unpaid')).toBe(false);
    expect(hasUsableAccess('incomplete')).toBe(false);
  });
});
