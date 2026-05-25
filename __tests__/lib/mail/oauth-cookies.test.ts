/**
 * Tests oauth-cookies.ts — constantes + buildRedirectUri partagées
 * entre /api/gmail/connect et /api/gmail/connect/callback.
 *
 * Couvre :
 *   - STATE_COOKIE / RETURN_COOKIE noms stables (cassent si tu renommes
 *     accidentellement — synchros entre les 2 routes obligatoire)
 *   - STATE_TTL_SECONDS = 10 min
 *   - buildRedirectUri construit le path canonique
 *   - buildRedirectUri marche pour les 3 hosts déclarés en Console Google
 */

import { describe, it, expect } from 'vitest';

import {
  STATE_COOKIE,
  RETURN_COOKIE,
  STATE_TTL_SECONDS,
  buildRedirectUri,
} from '@/lib/mail/oauth-cookies';

describe('OAuth cookie constants', () => {
  it('STATE_COOKIE name is stable (sync with both routes)', () => {
    expect(STATE_COOKIE).toBe('mail-oauth-state');
  });

  it('RETURN_COOKIE name is stable (sync with both routes)', () => {
    expect(RETURN_COOKIE).toBe('mail-oauth-return');
  });

  it('STATE_TTL_SECONDS is 10 minutes', () => {
    expect(STATE_TTL_SECONDS).toBe(600);
  });

  it('cookie names are distinct (avoid collision)', () => {
    expect(STATE_COOKIE).not.toBe(RETURN_COOKIE);
  });
});

describe('buildRedirectUri', () => {
  it('appends the canonical callback path to origin', () => {
    expect(buildRedirectUri('https://app.veridian.site')).toBe(
      'https://app.veridian.site/api/gmail/connect/callback',
    );
  });

  it('works for staging Tailscale host', () => {
    expect(buildRedirectUri('https://hub.staging.veridian.site')).toBe(
      'https://hub.staging.veridian.site/api/gmail/connect/callback',
    );
  });

  it('works for localhost', () => {
    expect(buildRedirectUri('http://localhost:3000')).toBe(
      'http://localhost:3000/api/gmail/connect/callback',
    );
  });

  it('does not normalize trailing slashes — caller must provide clean origin', () => {
    // Pas de slash dans l'origin = pas de double slash dans l'output. Si le
    // caller passe un origin avec trailing slash on aurait un double //
    // dans l'URL. Documenté pour qu'on ne casse pas la convention.
    const out = buildRedirectUri('https://app.veridian.site/');
    expect(out).toContain('//api');
  });
});
