import { describe, expect, it } from 'vitest';

import { deriveTrialStatus } from '@/lib/plans/trial-status';

const fin = new Date('2026-12-01T00:00:00Z');

describe('deriveTrialStatus', () => {
  it('rien : none', () => expect(deriveTrialStatus([], [])).toEqual({ status: 'none', endsAt: null }));
  it('abonnement actif : paid, même avec un essai en cours', () =>
    expect(deriveTrialStatus([{ state: 'trial_active', trialEndsAt: fin }], [{ status: 'active', trialEnd: null }]).status).toBe('paid'));
  it('essai converti : paid', () => expect(deriveTrialStatus([{ state: 'converted', trialEndsAt: null }], []).status).toBe('paid'));
  it('essai de la machine du Hub : trial_active avec sa fin', () =>
    expect(deriveTrialStatus([{ state: 'trial_ending_soon', trialEndsAt: fin }], [])).toEqual({ status: 'trial_active', endsAt: fin.toISOString() }));
  it('essai Stripe : trial_active', () =>
    expect(deriveTrialStatus([], [{ status: 'trialing', trialEnd: fin }])).toEqual({ status: 'trial_active', endsAt: fin.toISOString() }));
  it('essai fini sans conversion : expired', () =>
    expect(deriveTrialStatus([{ state: 'expired', trialEndsAt: fin }], [{ status: 'canceled', trialEnd: null }]).status).toBe('expired'));
  it('éligible seulement (pas encore démarré) : none', () =>
    expect(deriveTrialStatus([{ state: 'eligible', trialEndsAt: null }], []).status).toBe('none'));
});
