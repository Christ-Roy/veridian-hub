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
  validateReturnUrl,
  ALLOWED_RETURN_HOSTS,
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

  it('getHubBaseUrl force NEXT_PUBLIC_SITE_URL contre l\'origin 0.0.0.0 (anti-régression Traefik post-callback)', async () => {
    // Bug réel staging 2026-05-25 : NextResponse.redirect(new URL('/path',
    // request.url)) construisait 'https://0.0.0.0:3000/...' → ERR_ADDRESS_INVALID
    // côté browser. getHubBaseUrl doit IGNORER l'argument requestUrl quand
    // NEXT_PUBLIC_SITE_URL est set.
    const { getHubBaseUrl } = await import('@/lib/mail/oauth-cookies');
    const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://hub.staging.veridian.site';
    try {
      const url = getHubBaseUrl('https://0.0.0.0:3000/api/gmail/connect/callback?code=xyz');
      expect(url.host).toBe('hub.staging.veridian.site');
      expect(url.host).not.toContain('0.0.0.0');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NEXT_PUBLIC_SITE_URL;
      } else {
        process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
      }
    }
  });

  it('getHubBaseUrl tombe sur l\'origin reçu en local-dev (sans NEXT_PUBLIC_SITE_URL)', async () => {
    const { getHubBaseUrl } = await import('@/lib/mail/oauth-cookies');
    const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      const url = getHubBaseUrl('http://localhost:3000/api/gmail/connect');
      expect(url.host).toBe('localhost:3000');
    } finally {
      if (originalEnv !== undefined) process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
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

describe('validateReturnUrl — rebond OAuth cross-app (anti open-redirect)', () => {
  // ── Forme 1 : path relatif interne Hub ────────────────────────────────
  it('accepte un path relatif interne Hub', () => {
    expect(validateReturnUrl('/dashboard/settings/mail')).toBe(
      '/dashboard/settings/mail',
    );
  });

  it('accepte un path relatif avec query string', () => {
    expect(validateReturnUrl('/settings/mail-account?foo=1')).toBe(
      '/settings/mail-account?foo=1',
    );
  });

  it('REJETTE le protocol-relative //evil.com (open-redirect déguisé)', () => {
    expect(validateReturnUrl('//evil.com/phish')).toBe('');
  });

  // ── Forme 2 : URL absolue cross-domain allowlistée ────────────────────
  it('accepte une URL absolue HTTPS dont le host est allowlisté (Notifuse prod)', () => {
    const url =
      'https://notifuse.app.veridian.site/console/workspace/ws_1/settings/mail-account';
    expect(validateReturnUrl(url)).toBe(url);
  });

  it('accepte le host staging Notifuse (E2E cross-app)', () => {
    const url = 'https://notifuse.staging.veridian.site/console/x';
    expect(validateReturnUrl(url)).toBe(url);
  });

  it('accepte Prospection et CMS allowlistés', () => {
    expect(validateReturnUrl('https://prospection.app.veridian.site/x')).toBe(
      'https://prospection.app.veridian.site/x',
    );
    expect(validateReturnUrl('https://cms.veridian.site/x')).toBe(
      'https://cms.veridian.site/x',
    );
  });

  // ── Sécurité : tout le reste doit tomber à '' ─────────────────────────
  it('REJETTE un host hors allowlist (phishing)', () => {
    expect(validateReturnUrl('https://evil.com/steal')).toBe('');
  });

  it('REJETTE un host qui ressemble mais ne matche pas (sub-domaine pirate)', () => {
    // host exact comparé : un attaquant ne peut pas glisser le domaine
    // légitime dans un sous-domaine ou un path.
    expect(
      validateReturnUrl('https://notifuse.app.veridian.site.evil.com/x'),
    ).toBe('');
    expect(
      validateReturnUrl('https://evil.com/notifuse.app.veridian.site'),
    ).toBe('');
  });

  it('REJETTE le HTTP non sécurisé même sur un host allowlisté', () => {
    expect(validateReturnUrl('http://notifuse.app.veridian.site/x')).toBe('');
  });

  it('REJETTE les schemes dangereux (javascript:, data:)', () => {
    expect(validateReturnUrl('javascript:alert(1)')).toBe('');
    expect(validateReturnUrl('data:text/html,<script>')).toBe('');
  });

  it('traite null / undefined / vide / espaces comme pas de return', () => {
    expect(validateReturnUrl(null)).toBe('');
    expect(validateReturnUrl(undefined)).toBe('');
    expect(validateReturnUrl('')).toBe('');
    expect(validateReturnUrl('   ')).toBe('');
  });

  it('REJETTE une chaîne non-URL non-path', () => {
    expect(validateReturnUrl('pas une url')).toBe('');
  });

  it('ALLOWED_RETURN_HOSTS ne contient que des hosts (pas de scheme ni path)', () => {
    for (const host of ALLOWED_RETURN_HOSTS) {
      expect(host).not.toContain('://');
      expect(host).not.toContain('/');
      expect(host).toMatch(/veridian\.site$/);
    }
  });
});
