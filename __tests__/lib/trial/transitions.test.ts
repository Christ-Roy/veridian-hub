/**
 * Tests des helpers purs de la trial state machine.
 *
 * Couvre les frontières :
 *  - eligible <48h vs >=48h
 *  - trial_active <12j vs >=12j + déjà notifié
 *  - finalize avant vs après trial_ends_at
 *  - computeTrialEndsAt = +15 jours
 *
 * Aucun mock Prisma : ces fonctions sont des helpers de pure logique
 * mathématique sur des objets in-memory.
 */

import { describe, it, expect } from 'vitest';

import {
  computeTrialEndsAt,
  shouldActivateTrial,
  shouldFinalizeTrial,
  shouldNotifyEndingSoon,
  type TrialRow,
} from '@/lib/trial/transitions';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function baseRow(overrides: Partial<TrialRow> = {}): TrialRow {
  return {
    tenantId: 't_1',
    app: 'notifuse',
    state: 'eligible',
    eligibleAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    endingSoonNotified: false,
    ...overrides,
  };
}

describe('shouldActivateTrial', () => {
  it('returns false if state != eligible', () => {
    const row = baseRow({
      state: 'trial_active',
      eligibleAt: new Date(NOW.getTime() - 1000 * 60 * 60 * 100),
    });
    expect(shouldActivateTrial(row, NOW)).toBe(false);
  });

  it('returns false if eligibleAt is null', () => {
    const row = baseRow({ state: 'eligible', eligibleAt: null });
    expect(shouldActivateTrial(row, NOW)).toBe(false);
  });

  it('returns false if eligible since < 48h', () => {
    const row = baseRow({
      state: 'eligible',
      eligibleAt: new Date(NOW.getTime() - 47 * 60 * 60 * 1000),
    });
    expect(shouldActivateTrial(row, NOW)).toBe(false);
  });

  it('returns true if eligible since exactly 48h', () => {
    const row = baseRow({
      state: 'eligible',
      eligibleAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
    });
    expect(shouldActivateTrial(row, NOW)).toBe(true);
  });

  it('returns true if eligible since > 48h', () => {
    const row = baseRow({
      state: 'eligible',
      eligibleAt: new Date(NOW.getTime() - 72 * 60 * 60 * 1000),
    });
    expect(shouldActivateTrial(row, NOW)).toBe(true);
  });
});

describe('shouldNotifyEndingSoon', () => {
  it('returns false if state != trial_active', () => {
    const row = baseRow({
      state: 'eligible',
      trialStartedAt: new Date(NOW.getTime() - 13 * 24 * 60 * 60 * 1000),
    });
    expect(shouldNotifyEndingSoon(row, NOW)).toBe(false);
  });

  it('returns false if already notified', () => {
    const row = baseRow({
      state: 'trial_active',
      trialStartedAt: new Date(NOW.getTime() - 13 * 24 * 60 * 60 * 1000),
      endingSoonNotified: true,
    });
    expect(shouldNotifyEndingSoon(row, NOW)).toBe(false);
  });

  it('returns false if trial_active since < 12 days', () => {
    const row = baseRow({
      state: 'trial_active',
      trialStartedAt: new Date(NOW.getTime() - 11 * 24 * 60 * 60 * 1000),
    });
    expect(shouldNotifyEndingSoon(row, NOW)).toBe(false);
  });

  it('returns true if trial_active since exactly 12 days', () => {
    const row = baseRow({
      state: 'trial_active',
      trialStartedAt: new Date(NOW.getTime() - 12 * 24 * 60 * 60 * 1000),
    });
    expect(shouldNotifyEndingSoon(row, NOW)).toBe(true);
  });
});

describe('shouldFinalizeTrial', () => {
  it('returns false if state != trial_active', () => {
    const row = baseRow({
      state: 'expired',
      trialEndsAt: new Date(NOW.getTime() - 1000),
    });
    expect(shouldFinalizeTrial(row, NOW)).toBe(false);
  });

  it('returns false if trial_ends_at in the future', () => {
    const row = baseRow({
      state: 'trial_active',
      trialEndsAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });
    expect(shouldFinalizeTrial(row, NOW)).toBe(false);
  });

  it('returns true if trial_ends_at is now or past', () => {
    const row = baseRow({
      state: 'trial_active',
      trialEndsAt: new Date(NOW.getTime()),
    });
    expect(shouldFinalizeTrial(row, NOW)).toBe(true);

    const past = baseRow({
      state: 'trial_active',
      trialEndsAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    expect(shouldFinalizeTrial(past, NOW)).toBe(true);
  });
});

describe('computeTrialEndsAt', () => {
  it('adds exactly 15 UTC days to the activation date', () => {
    const activatedAt = new Date('2026-06-15T12:00:00.000Z');
    const end = computeTrialEndsAt(activatedAt);
    expect(end.toISOString()).toBe('2026-06-30T12:00:00.000Z');
  });

  it('crosses month boundary correctly', () => {
    const activatedAt = new Date('2026-12-20T09:00:00.000Z');
    const end = computeTrialEndsAt(activatedAt);
    expect(end.toISOString()).toBe('2027-01-04T09:00:00.000Z');
  });
});
