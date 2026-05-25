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

  it('does not normalize trailing slashes — caller must provide clean origin (fallback path, sans env)', () => {
    // Quand NEXT_PUBLIC_SITE_URL n'est PAS set, on retombe sur l'`origin`
    // passé en argument sans normalization. Si le caller met un trailing
    // slash → double // dans l'URL. C'est le comportement legacy
    // (DocumentURI documenté pour qu'on ne casse pas la convention).
    const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      const out = buildRedirectUri('https://app.veridian.site/');
      expect(out).toContain('//api');
    } finally {
      if (originalEnv !== undefined) process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
    }
  });

  it('prend NEXT_PUBLIC_SITE_URL en priorité quand il est set (fix Traefik 0.0.0.0)', () => {
    // ANTI-RÉGRESSION : derrière Traefik / reverse proxy, Next.js bind
    // sur 0.0.0.0:3000 → le `origin` calculé par la route serait
    // "https://0.0.0.0:3000" → Google rejette "invalid_request". On doit
    // toujours utiliser NEXT_PUBLIC_SITE_URL si dispo (env compose).
    const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://hub.staging.veridian.site';
    try {
      const out = buildRedirectUri('https://0.0.0.0:3000');
      expect(out).toBe(
        'https://hub.staging.veridian.site/api/gmail/connect/callback',
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NEXT_PUBLIC_SITE_URL;
      } else {
        process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
      }
    }
  });

  it('normalize les trailing slashes de NEXT_PUBLIC_SITE_URL', () => {
    const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.veridian.site/';
    try {
      const out = buildRedirectUri('https://0.0.0.0:3000');
      expect(out).toBe('https://app.veridian.site/api/gmail/connect/callback');
      expect(out).not.toContain('//api');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NEXT_PUBLIC_SITE_URL;
      } else {
        process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
      }
    }
  });
});
