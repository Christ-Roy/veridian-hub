/**
 * Tests des constantes business de la trial state machine.
 *
 * Ces constantes ont été figées par Robert le 2026-05-21 (cf
 * `docs/PRICING-VERIDIAN.md` §"Flow trial complet"). Le test sert de
 * "lock" anti-régression : si quelqu'un modifie 48h en 24h ou 15j en 7j
 * par erreur, la suite plante et force une revue produit.
 */

import { describe, it, expect } from 'vitest';

import {
  TRIAL_DURATION_DAYS,
  TRIAL_ELIGIBLE_WAIT_HOURS,
  TRIAL_NOTIFY_ENDING_SOON_DAYS,
  TRIAL_SUPPORTED_APPS,
  isTrialApp,
} from '@/lib/trial/constants';

describe('trial constants', () => {
  it('TRIAL_ELIGIBLE_WAIT_HOURS = 48h (cooldown post-signal Robert 2026-05-21)', () => {
    expect(TRIAL_ELIGIBLE_WAIT_HOURS).toBe(48);
  });

  it('TRIAL_DURATION_DAYS = 15 (durée trial Pro Robert 2026-05-21)', () => {
    expect(TRIAL_DURATION_DAYS).toBe(15);
  });

  it('TRIAL_NOTIFY_ENDING_SOON_DAYS = 12 (3j avant fin du trial 15j)', () => {
    expect(TRIAL_NOTIFY_ENDING_SOON_DAYS).toBe(12);
    expect(TRIAL_DURATION_DAYS - TRIAL_NOTIFY_ENDING_SOON_DAYS).toBe(3);
  });

  it('TRIAL_SUPPORTED_APPS contains notifuse + prospection + analytics (no CMS)', () => {
    expect([...TRIAL_SUPPORTED_APPS]).toEqual([
      'notifuse',
      'prospection',
      'analytics',
    ]);
  });
});

describe('isTrialApp', () => {
  it('accepts the 3 supported apps', () => {
    expect(isTrialApp('notifuse')).toBe(true);
    expect(isTrialApp('prospection')).toBe(true);
    expect(isTrialApp('analytics')).toBe(true);
  });

  it('rejects unsupported strings and non-string values', () => {
    expect(isTrialApp('cms')).toBe(false);
    expect(isTrialApp('')).toBe(false);
    expect(isTrialApp(null)).toBe(false);
    expect(isTrialApp(undefined)).toBe(false);
    expect(isTrialApp(42)).toBe(false);
    expect(isTrialApp({ app: 'notifuse' })).toBe(false);
  });
});
