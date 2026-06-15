/**
 * Tests du barème de scoring (lib/prospect/scoring.ts).
 *
 * Fonctions pures — on vérifie le barème exact, le no-op sur event inconnu,
 * et l'agrégation immutable des signaux.
 */

import { describe, it, expect } from 'vitest';

import {
  EVENT_SCORE,
  SCORABLE_EVENT_TYPES,
  bumpSignals,
  isProspectEventType,
  scoreForEvent,
} from '@/lib/prospect/scoring';

describe('scoreForEvent', () => {
  it('applies the V1 barème: opened +1, clicked +5, replied +20, page.hit +3', () => {
    expect(scoreForEvent('email.opened')).toBe(1);
    expect(scoreForEvent('email.clicked')).toBe(5);
    expect(scoreForEvent('email.replied')).toBe(20);
    expect(scoreForEvent('page.hit')).toBe(3);
  });

  it('barème constant matches EVENT_SCORE source of truth', () => {
    expect(EVENT_SCORE).toEqual({
      'email.opened': 1,
      'email.clicked': 5,
      'email.replied': 20,
      'page.hit': 3,
    });
  });

  it('returns 0 for unknown event types (ingested but not scored)', () => {
    expect(scoreForEvent('tenant.suspended')).toBe(0);
    expect(scoreForEvent('email.bounced')).toBe(0);
    expect(scoreForEvent('')).toBe(0);
    expect(scoreForEvent('garbage')).toBe(0);
  });
});

describe('isProspectEventType', () => {
  it('recognizes the 4 scorable events', () => {
    for (const t of SCORABLE_EVENT_TYPES) {
      expect(isProspectEventType(t)).toBe(true);
    }
  });

  it('rejects non-behavioral / non-string', () => {
    expect(isProspectEventType('tenant.touched')).toBe(false);
    expect(isProspectEventType(undefined)).toBe(false);
    expect(isProspectEventType(null)).toBe(false);
    expect(isProspectEventType(42)).toBe(false);
  });
});

describe('bumpSignals', () => {
  it('increments the right counter key for each event', () => {
    expect(bumpSignals(null, 'email.opened')).toEqual({ opened: 1 });
    expect(bumpSignals(null, 'email.clicked')).toEqual({ clicked: 1 });
    expect(bumpSignals(null, 'email.replied')).toEqual({ replied: 1 });
    expect(bumpSignals(null, 'page.hit')).toEqual({ page_hit: 1 });
  });

  it('accumulates onto existing signals without mutating the input', () => {
    const prev = { opened: 2, clicked: 1 };
    const next = bumpSignals(prev, 'email.opened');
    expect(next).toEqual({ opened: 3, clicked: 1 });
    // input non muté
    expect(prev).toEqual({ opened: 2, clicked: 1 });
  });

  it('leaves signals unchanged on unknown event type', () => {
    const prev = { opened: 1 };
    expect(bumpSignals(prev, 'email.bounced')).toEqual({ opened: 1 });
  });

  it('treats a non-numeric existing counter as 0', () => {
    const prev = { opened: 'oops' } as unknown as Record<string, number>;
    expect(bumpSignals(prev, 'email.opened')).toEqual({ opened: 1 });
  });

  it('handles undefined input as empty map', () => {
    expect(bumpSignals(undefined, 'email.replied')).toEqual({ replied: 1 });
  });
});
