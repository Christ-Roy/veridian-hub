/**
 * Tests du tracking GTM côté client (lib/gtm.ts).
 *
 * Couvre le comportement observable : les fonctions poussent le bon event dans
 * `window.dataLayer`, et NE spamment PLUS la console en prod (3 console.log
 * inconditionnels retirés — ils polluaient la console des visiteurs et
 * exposaient le user ID). `window.dataLayer` est mocké.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { trackEvent, setUserId, clearUserId } from '@/lib/gtm';

let logSpy: MockInstance;

beforeEach(() => {
  // dataLayer mocké : array réel pour vérifier les push.
  (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
});

function lastPush(): Record<string, unknown> {
  const dl = (window as unknown as { dataLayer: Record<string, unknown>[] })
    .dataLayer;
  return dl[dl.length - 1];
}

describe('gtm — trackEvent', () => {
  it('pousse l\'event dans dataLayer avec les bons champs', () => {
    trackEvent('test_event', { foo: 'bar' });
    const pushed = lastPush();
    expect(pushed.event).toBe('test_event');
    expect(pushed.foo).toBe('bar');
    // Champs auto enrichis (page_url/page_path présents).
    expect(pushed).toHaveProperty('page_url');
    expect(pushed).toHaveProperty('page_path');
  });

  it('NE log PAS en prod (pas de console.log de tracking — anti-spam visiteur)', () => {
    trackEvent('test_event');
    // NODE_ENV n'est pas 'development' en test → aucun console.log attendu.
    // (Le seul console.log restant est gated NODE_ENV==='development'.)
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('gtm — setUserId / clearUserId', () => {
  it('setUserId pousse user_id_set sans logger le user ID', () => {
    setUserId('user-123');
    const pushed = lastPush();
    expect(pushed.event).toBe('user_id_set');
    expect(pushed.user_id).toBe('user-123');
    // Le user ID ne doit PLUS être loggé dans la console (leak/bruit retiré).
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('clearUserId pousse user_id_cleared sans logger', () => {
    clearUserId();
    const pushed = lastPush();
    expect(pushed.event).toBe('user_id_cleared');
    expect(pushed.user_id).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
