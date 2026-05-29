/**
 * Tests pour lib/confetti.ts — célébration visuelle (canvas-confetti).
 *
 * Comportement vérifié (pas de rendu réel, on mocke la lib) :
 *  - celebrate() tire 2 salves de confettis (coins bas gauche + droit)
 *  - no-op si prefers-reduced-motion (accessibilité)
 *  - no-op côté serveur (window absent) — pas de crash SSR
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const confettiMock = vi.hoisted(() => vi.fn());
vi.mock('canvas-confetti', () => ({ default: confettiMock }));

import { celebrate } from '@/lib/confetti';

describe('celebrate', () => {
  beforeEach(() => {
    confettiMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tire 2 salves de confettis quand le mouvement est autorisé', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    });
    celebrate();
    expect(confettiMock).toHaveBeenCalledTimes(2);
    // Une salve depuis chaque coin bas (x:0 et x:1)
    const origins = confettiMock.mock.calls.map((c) => c[0].origin);
    expect(origins).toContainEqual({ x: 0, y: 1 });
    expect(origins).toContainEqual({ x: 1, y: 1 });
  });

  it('no-op si prefers-reduced-motion (accessibilité)', () => {
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({ matches: q.includes('reduce') }),
    });
    celebrate();
    expect(confettiMock).not.toHaveBeenCalled();
  });

  it('no-op côté serveur (window absent) — pas de crash SSR', () => {
    vi.stubGlobal('window', undefined);
    expect(() => celebrate()).not.toThrow();
    expect(confettiMock).not.toHaveBeenCalled();
  });
});
