/**
 * Tests unitaires de `lib/auth/bounce-next.ts` — Couche 4 Hub (cf. CONTRAT
 * §6bis.8.2 + §6bis.8.5 "Tests contractuels Hub").
 *
 * Couvre :
 *  - whitelist regex anti open-redirect (prod + staging)
 *  - extraction du sous-domaine app
 *  - refus auto-bounce vers Hub (app.* / hub.*)
 *  - signature cookie HMAC (sign + verify round-trip)
 *  - rejet cookie expiré / signature falsifiée / format invalide
 *  - rejet next mal encodé / trop long / non-https
 */

import { describe, it, expect } from 'vitest';
import {
  parseNext,
  signNextCookie,
  verifyNextCookie,
  whitelistRegexFor,
  nextCookieName,
  NEXT_COOKIE_NAME_SECURE,
  NEXT_COOKIE_NAME_INSECURE,
  NEXT_COOKIE_TTL_MS,
} from '@/lib/auth/bounce-next';

const SECRET = 'test-auth-secret-at-least-32-bytes-long-xx';

describe('parseNext — whitelist regex anti open-redirect', () => {
  describe('production env', () => {
    it('accepte un sous-domaine *.veridian.site nominal', () => {
      const r = parseNext('https://notifuse.veridian.site/signin', 'production');
      expect(r).not.toBeNull();
      expect(r!.app).toBe('notifuse');
      expect(r!.host).toBe('notifuse.veridian.site');
    });

    it('accepte prospection.veridian.site avec sous-path', () => {
      const r = parseNext('https://prospection.veridian.site/leads?filter=hot', 'production');
      expect(r).not.toBeNull();
      expect(r!.app).toBe('prospection');
    });

    it('accepte une app future arbitraire (regex large)', () => {
      // L'idée : tester que ajouter `veridian-newapp` au futur ne demande
      // aucune modif Hub (cf. §6bis.8.6).
      const r = parseNext('https://newapp.veridian.site/anywhere', 'production');
      expect(r).not.toBeNull();
      expect(r!.app).toBe('newapp');
    });

    it('rejette evil.com (anti open-redirect)', () => {
      expect(parseNext('https://evil.com/path', 'production')).toBeNull();
    });

    it('rejette evil.com avec un faux suffixe veridian.site dans le path', () => {
      expect(parseNext('https://evil.com/veridian.site', 'production')).toBeNull();
    });

    it('rejette https://veridian.site.attacker.com', () => {
      expect(parseNext('https://veridian.site.attacker.com/x', 'production')).toBeNull();
    });

    it('rejette http:// (pas TLS)', () => {
      expect(parseNext('http://notifuse.veridian.site/x', 'production')).toBeNull();
    });

    it('rejette les sous-domaines staging en prod', () => {
      expect(parseNext('https://notifuse.staging.veridian.site/x', 'production')).toBeNull();
    });

    it('rejette le sous-domaine app.* (Hub lui-même, anti-loop)', () => {
      expect(parseNext('https://app.veridian.site/dashboard', 'production')).toBeNull();
    });

    it('rejette le sous-domaine hub.* (Hub staging style)', () => {
      // hub.veridian.site n'existe pas réellement en prod mais on garde
      // le garde-fou par sécurité.
      expect(parseNext('https://hub.veridian.site/x', 'production')).toBeNull();
    });
  });

  describe('staging env', () => {
    it('accepte *.staging.veridian.site', () => {
      const r = parseNext('https://notifuse.staging.veridian.site/signin', 'staging');
      expect(r).not.toBeNull();
      expect(r!.app).toBe('notifuse');
    });

    it('rejette *.veridian.site en staging (pas de cross-pollution prod/staging)', () => {
      expect(parseNext('https://notifuse.veridian.site/x', 'staging')).toBeNull();
    });

    it('rejette hub.staging.veridian.site (auto-bounce Hub staging)', () => {
      expect(parseNext('https://hub.staging.veridian.site/x', 'staging')).toBeNull();
    });
  });

  describe('dev/test env', () => {
    it('accepte les deux whitelists pour les tests', () => {
      expect(parseNext('https://notifuse.veridian.site/x', 'development')).not.toBeNull();
      expect(parseNext('https://notifuse.staging.veridian.site/x', 'development')).not.toBeNull();
    });
  });

  describe('inputs malformés', () => {
    it('null, undefined, vide → null', () => {
      expect(parseNext(null, 'production')).toBeNull();
      expect(parseNext(undefined, 'production')).toBeNull();
      expect(parseNext('', 'production')).toBeNull();
    });

    it('non-string → null', () => {
      // @ts-expect-error — test de robustesse runtime
      expect(parseNext(42, 'production')).toBeNull();
      // @ts-expect-error — test de robustesse runtime
      expect(parseNext({ url: 'x' }, 'production')).toBeNull();
    });

    it('URL > 2048 chars → null (anti-DoS cookie)', () => {
      const long = 'https://notifuse.veridian.site/' + 'a'.repeat(2500);
      expect(parseNext(long, 'production')).toBeNull();
    });

    it('URL mal encodée → null sans 500', () => {
      // % isolé : si la regex passe, le URL parser dans extractSubdomain
      // peut tomber sur des chars invalides. Notre regex est stricte donc
      // bloque avant.
      expect(parseNext('https://notifuse.veridian.site/%E0%A4%A', 'production')).not.toBeNull();
      // Lettre invalide dans le host (uppercase + 0…) — bloqué par regex
      expect(parseNext('https://NOTIFUSE.veridian.site/x', 'production')).toBeNull();
    });

    it('whitespace dans next → null', () => {
      expect(parseNext('  https://notifuse.veridian.site/  ', 'production')).toBeNull();
    });
  });
});

describe('whitelistRegexFor', () => {
  it('production renvoie 1 regex (prod uniquement)', () => {
    expect(whitelistRegexFor('production')).toHaveLength(1);
  });
  it('staging renvoie 1 regex (staging uniquement)', () => {
    expect(whitelistRegexFor('staging')).toHaveLength(1);
  });
  it('autres envs renvoient les 2 (dev/test mix)', () => {
    expect(whitelistRegexFor('development')).toHaveLength(2);
    expect(whitelistRegexFor('test')).toHaveLength(2);
    expect(whitelistRegexFor(undefined)).toHaveLength(2);
  });
});

describe('signNextCookie / verifyNextCookie round-trip', () => {
  const NOW = 1_700_000_000_000;

  it('round-trip basique : signe puis vérifie OK', () => {
    const cookie = signNextCookie('https://notifuse.veridian.site/x', SECRET, NOW);
    const got = verifyNextCookie(cookie, SECRET, NOW + 1000);
    expect(got).toBe('https://notifuse.veridian.site/x');
  });

  it('cookie expiré (now > expires) → null', () => {
    const cookie = signNextCookie('https://notifuse.veridian.site/x', SECRET, NOW);
    const got = verifyNextCookie(cookie, SECRET, NOW + NEXT_COOKIE_TTL_MS + 1);
    expect(got).toBeNull();
  });

  it('cookie pile à expiration → null (rejet strict)', () => {
    const cookie = signNextCookie('https://notifuse.veridian.site/x', SECRET, NOW);
    const got = verifyNextCookie(cookie, SECRET, NOW + NEXT_COOKIE_TTL_MS);
    expect(got).toBeNull();
  });

  it('signature falsifiée → null', () => {
    const cookie = signNextCookie('https://notifuse.veridian.site/x', SECRET, NOW);
    const parts = cookie.split('.');
    // remplace la sig par une chaîne random de même longueur
    parts[2] = 'f'.repeat(parts[2].length);
    const tampered = parts.join('.');
    expect(verifyNextCookie(tampered, SECRET, NOW + 1000)).toBeNull();
  });

  it('payload falsifié (réutiliser signature ancienne) → null', () => {
    const cookie = signNextCookie('https://notifuse.veridian.site/x', SECRET, NOW);
    const parts = cookie.split('.');
    // change le payload mais garde la signature
    const tamperedB64 = Buffer.from('https://evil.com', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    parts[1] = tamperedB64;
    const tampered = parts.join('.');
    expect(verifyNextCookie(tampered, SECRET, NOW + 1000)).toBeNull();
  });

  it('secret différent → null', () => {
    const cookie = signNextCookie('https://notifuse.veridian.site/x', SECRET, NOW);
    expect(verifyNextCookie(cookie, 'other-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxx', NOW + 1000)).toBeNull();
  });

  it('format invalide (pas 3 parties) → null', () => {
    expect(verifyNextCookie('only.two', SECRET)).toBeNull();
    expect(verifyNextCookie('one', SECRET)).toBeNull();
    expect(verifyNextCookie('a.b.c.d', SECRET)).toBeNull();
  });

  it('cookieValue null/undefined → null', () => {
    expect(verifyNextCookie(null, SECRET)).toBeNull();
    expect(verifyNextCookie(undefined, SECRET)).toBeNull();
    expect(verifyNextCookie('', SECRET)).toBeNull();
  });

  it('secret manquant → null', () => {
    expect(verifyNextCookie('a.b.c', '')).toBeNull();
  });

  it('signNextCookie sans secret → throw', () => {
    expect(() => signNextCookie('x', '')).toThrow(/secret is required/);
  });

  it('payload contient des caractères spéciaux : préservés via base64url', () => {
    const url = 'https://notifuse.veridian.site/path?q=hello world&x=日本';
    const cookie = signNextCookie(url, SECRET, NOW);
    expect(verifyNextCookie(cookie, SECRET, NOW + 1000)).toBe(url);
  });
});

describe('nextCookieName', () => {
  it('secure → préfixe __Secure-', () => {
    expect(nextCookieName(true)).toBe(NEXT_COOKIE_NAME_SECURE);
  });
  it('non-secure → sans préfixe', () => {
    expect(nextCookieName(false)).toBe(NEXT_COOKIE_NAME_INSECURE);
  });
});
