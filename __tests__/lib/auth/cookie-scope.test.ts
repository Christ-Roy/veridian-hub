import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import {
  resolveSessionCookieName,
  resolveHintCookieDomain,
  hasAuthSessionCookie,
} from '@/lib/auth/cookie-scope';

describe('resolveSessionCookieName', () => {
  it('préfixe __Secure- en production build (NODE_ENV=production)', () => {
    expect(resolveSessionCookieName({ NODE_ENV: 'production' })).toBe(
      '__Secure-authjs.session-token',
    );
  });

  it('pas de préfixe en dev (NODE_ENV=development)', () => {
    expect(resolveSessionCookieName({ NODE_ENV: 'development' })).toBe('authjs.session-token');
  });

  it('pas de préfixe en test', () => {
    expect(resolveSessionCookieName({ NODE_ENV: 'test' })).toBe('authjs.session-token');
  });
});

describe('resolveHintCookieDomain (cookie HINT cross-subdomain — pas le sessionToken)', () => {
  it('renvoie .veridian.site quand DEPLOY_ENV=prod', () => {
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'prod' })).toBe('.veridian.site');
  });

  it('renvoie .staging.veridian.site quand DEPLOY_ENV=staging', () => {
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'staging' })).toBe('.staging.veridian.site');
  });

  it('renvoie undefined quand DEPLOY_ENV absent (local-dev)', () => {
    expect(resolveHintCookieDomain({})).toBeUndefined();
  });

  it('renvoie undefined pour DEPLOY_ENV inconnu (préprod / test runner)', () => {
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'preprod' })).toBeUndefined();
    expect(resolveHintCookieDomain({ DEPLOY_ENV: 'test' })).toBeUndefined();
  });

  it("ne se base PAS sur NODE_ENV (piège staging build prod, cf. memory feedback_node_env_vs_deploy_env)", () => {
    // NODE_ENV=production en staging (build Next.js) ne doit pas faire matcher .veridian.site
    expect(resolveHintCookieDomain({ NODE_ENV: 'production' })).toBeUndefined();
  });
});

// Le hint cross-subdomain n'est qu'un cache d'affichage : /api/me/lite ne
// doit le croire que si le cookie session Auth.js accompagne la requête.
// Sans ce garde-fou, un hint qui survit à une déconnexion se fait valider par
// l'API censée le corriger (bug landing "Mon compte" pendant 30 jours).
describe('hasAuthSessionCookie', () => {
  const ENV_PROD = { NODE_ENV: 'production' };

  function reqWithCookies(cookies: Record<string, string>): NextRequest {
    const req = new NextRequest('http://localhost/api/me/lite');
    for (const [name, value] of Object.entries(cookies)) {
      req.cookies.set(name, value);
    }
    return req;
  }

  it('true quand le cookie session prod est présent', () => {
    const req = reqWithCookies({ '__Secure-authjs.session-token': 'jwe' });
    expect(hasAuthSessionCookie(req, ENV_PROD)).toBe(true);
  });

  it('true sur les chunks .0/.1 (grosse session éclatée par Auth.js)', () => {
    const req = reqWithCookies({
      '__Secure-authjs.session-token.0': 'a',
      '__Secure-authjs.session-token.1': 'b',
    });
    expect(hasAuthSessionCookie(req, ENV_PROD)).toBe(true);
  });

  it('false quand seul le hint traîne (déconnecté)', () => {
    const req = reqWithCookies({ 'veridian-session-hint': 'jwt' });
    expect(hasAuthSessionCookie(req, ENV_PROD)).toBe(false);
  });

  it('false sur une valeur vide (cookie déjà supprimé par Auth.js)', () => {
    const req = reqWithCookies({ '__Secure-authjs.session-token': '' });
    expect(hasAuthSessionCookie(req, ENV_PROD)).toBe(false);
  });

  it('false si le nom ne correspond pas à l\'env (dev vs prod)', () => {
    // Cookie non préfixé alors qu'on résout le nom prod → pas de faux positif.
    const req = reqWithCookies({ 'authjs.session-token': 'jwe' });
    expect(hasAuthSessionCookie(req, ENV_PROD)).toBe(false);
    expect(hasAuthSessionCookie(req, { NODE_ENV: 'development' })).toBe(true);
  });

  it('false sans aucun cookie', () => {
    expect(hasAuthSessionCookie(reqWithCookies({}), ENV_PROD)).toBe(false);
  });
});
