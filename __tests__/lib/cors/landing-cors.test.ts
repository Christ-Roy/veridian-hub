import { describe, it, expect } from 'vitest';
import {
  getAllowedLandingOrigins,
  getAllowedLandingOrigin,
  buildLandingCorsHeaders,
  landingCorsPreflightResponse,
} from '@/lib/cors/landing-cors';

function makeReq(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as never;
}

describe('getAllowedLandingOrigins', () => {
  it('inclut les défauts veridian.site + www.veridian.site', () => {
    const origins = getAllowedLandingOrigins({});
    expect(origins).toContain('https://veridian.site');
    expect(origins).toContain('https://www.veridian.site');
  });

  it('ajoute LANDING_ORIGIN si configuré', () => {
    const origins = getAllowedLandingOrigins({
      DEPLOY_ENV: 'prod',
      LANDING_ORIGIN: 'https://veridian.io',
    });
    expect(origins).toContain('https://veridian.io');
  });

  it('ajoute LANDING_ORIGIN_STAGING en staging', () => {
    const origins = getAllowedLandingOrigins({
      DEPLOY_ENV: 'staging',
      LANDING_ORIGIN_STAGING: 'https://veridian.staging.site',
    });
    expect(origins).toContain('https://veridian.staging.site');
  });

  it('ignore LANDING_ORIGIN_STAGING en prod', () => {
    const origins = getAllowedLandingOrigins({
      DEPLOY_ENV: 'prod',
      LANDING_ORIGIN_STAGING: 'https://veridian.staging.site',
    });
    expect(origins).not.toContain('https://veridian.staging.site');
  });

  it('inclut localhost en local-dev (DEPLOY_ENV absent)', () => {
    const origins = getAllowedLandingOrigins({});
    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://localhost:5173');
  });

  it('rejette LANDING_ORIGIN invalide (wildcard, slash terminal, parse fail)', () => {
    const origins = getAllowedLandingOrigins({
      DEPLOY_ENV: 'prod',
      LANDING_ORIGIN: 'https://*.veridian.site',
    });
    expect(origins).not.toContain('https://*.veridian.site');

    const origins2 = getAllowedLandingOrigins({
      DEPLOY_ENV: 'prod',
      LANDING_ORIGIN: 'https://veridian.io/',
    });
    expect(origins2).not.toContain('https://veridian.io/');

    const origins3 = getAllowedLandingOrigins({
      DEPLOY_ENV: 'prod',
      LANDING_ORIGIN: 'not-a-url',
    });
    expect(origins3).not.toContain('not-a-url');
  });

  it('dédupliqué (LANDING_ORIGIN = un défaut ne crée pas de doublon)', () => {
    const origins = getAllowedLandingOrigins({
      DEPLOY_ENV: 'prod',
      LANDING_ORIGIN: 'https://veridian.site',
    });
    expect(origins.filter((o) => o === 'https://veridian.site').length).toBe(1);
  });
});

describe('getAllowedLandingOrigin', () => {
  const env = { DEPLOY_ENV: 'prod' };

  it('echo origin whitelisté', () => {
    const req = makeReq({ origin: 'https://veridian.site' });
    expect(getAllowedLandingOrigin(req, env)).toBe('https://veridian.site');
  });

  it('null si origin absent', () => {
    const req = makeReq({});
    expect(getAllowedLandingOrigin(req, env)).toBeNull();
  });

  it('null si origin non whitelisté', () => {
    const req = makeReq({ origin: 'https://evil.com' });
    expect(getAllowedLandingOrigin(req, env)).toBeNull();
  });

  it('null si origin proche mais pas exact (sous-domaine inconnu)', () => {
    const req = makeReq({ origin: 'https://attacker.veridian.site' });
    expect(getAllowedLandingOrigin(req, env)).toBeNull();
  });
});

describe('buildLandingCorsHeaders', () => {
  it('renvoie Allow-Origin echoed + Allow-Credentials true pour origin whitelisté', () => {
    const req = makeReq({ origin: 'https://veridian.site' });
    const headers = buildLandingCorsHeaders(req, {}, { DEPLOY_ENV: 'prod' });
    expect(headers['Access-Control-Allow-Origin']).toBe('https://veridian.site');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers['Vary']).toBe('Origin');
  });

  it('renvoie SEULEMENT Vary pour origin non whitelisté (pas de Allow-Origin)', () => {
    const req = makeReq({ origin: 'https://evil.com' });
    const headers = buildLandingCorsHeaders(req, {}, { DEPLOY_ENV: 'prod' });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(headers['Vary']).toBe('Origin');
  });

  it('Vary: Origin posé même sans header origin (anti-cache empoisonnement)', () => {
    const req = makeReq({});
    const headers = buildLandingCorsHeaders(req, {}, { DEPLOY_ENV: 'prod' });
    expect(headers['Vary']).toBe('Origin');
  });

  it('methods custom respectées', () => {
    const req = makeReq({ origin: 'https://veridian.site' });
    const headers = buildLandingCorsHeaders(
      req,
      { methods: ['POST', 'OPTIONS'] },
      { DEPLOY_ENV: 'prod' },
    );
    expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
  });

  it('Max-Age fixé à 3600 (1h) — pas trop long pour rotation whitelist', () => {
    const req = makeReq({ origin: 'https://veridian.site' });
    const headers = buildLandingCorsHeaders(req, {}, { DEPLOY_ENV: 'prod' });
    expect(headers['Access-Control-Max-Age']).toBe('3600');
  });
});

describe('landingCorsPreflightResponse', () => {
  it('renvoie 204 + headers CORS pour origin whitelisté', async () => {
    const req = makeReq({ origin: 'https://veridian.site' });
    const res = landingCorsPreflightResponse(req, {}, { DEPLOY_ENV: 'prod' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://veridian.site');
  });

  it('renvoie 204 sans Allow-Origin pour origin rejeté (browser bloque la vraie req)', async () => {
    const req = makeReq({ origin: 'https://evil.com' });
    const res = landingCorsPreflightResponse(req, {}, { DEPLOY_ENV: 'prod' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
