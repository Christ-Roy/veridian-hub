/**
 * Tests structuraux de `auth.config.ts` — vérifie que les 2 providers OAuth
 * (Google + Microsoft Entra) sont correctement configurés selon les décisions
 * documentées dans `todo/2026-05-20-oauth-signin-google-microsoft-cross-app.md`.
 *
 * Ces tests servent de garde-fou contre les régressions silencieuses sur la
 * config OAuth — si quelqu'un retire `allowDangerousEmailAccountLinking` par
 * erreur, le scénario "user existant tente login Google" repète à pleurer
 * en prod sans qu'on s'en rende compte.
 */

import { describe, it, expect } from 'vitest';
import { authConfig } from '@/auth.config';

describe('auth.config.ts — OAuth providers', () => {
  it('configure 2 providers OAuth : Google + MicrosoftEntraID', () => {
    const ids = authConfig.providers.map((p) => {
      const provider = typeof p === 'function' ? p({}) : p;
      return ('id' in provider ? provider.id : null) as string | null;
    });
    expect(ids).toContain('google');
    expect(ids).toContain('microsoft-entra-id');
  });

  // Auth.js v5 stocke la config passée par l'utilisateur dans `provider.options`.
  // Les valeurs `id/name/type/issuer/style` au top-level sont les defaults
  // du provider (côté @auth/core).
  function getProviderOptions(id: string): Record<string, unknown> {
    const p = authConfig.providers.find((pp) => {
      const prov = typeof pp === 'function' ? pp({}) : pp;
      return 'id' in prov && prov.id === id;
    });
    const provider = (typeof p === 'function' ? p({}) : p) as { options?: Record<string, unknown> };
    if (!provider?.options) throw new Error(`provider ${id} missing options`);
    return provider.options;
  }

  it('Google : scope minimal openid+email+profile + prompt=select_account', () => {
    const opts = getProviderOptions('google');
    const auth = opts.authorization as { params?: Record<string, string> };
    expect(auth?.params?.scope).toBe('openid email profile');
    expect(auth?.params?.prompt).toBe('select_account');
  });

  it('Google + Microsoft : allowDangerousEmailAccountLinking activé', () => {
    // C'est ce flag qui empêche `?error=OAuthAccountNotLinked` pour les
    // users existants (créés via Credentials/magic) qui tentent OAuth.
    // Sans ce flag, le scénario C/D casse silencieusement (cf. todo
    // 2026-05-20-oauth-scenarios-coverage.md).
    for (const id of ['google', 'microsoft-entra-id']) {
      const opts = getProviderOptions(id);
      expect(
        opts.allowDangerousEmailAccountLinking,
        `${id}: flag obligatoire pour link automatique cross-provider`,
      ).toBe(true);
    }
  });

  it('Microsoft : issuer = common (= multi-tenant, accepte tous comptes Microsoft)', () => {
    // L'issuer doit pointer vers `/common/` pour rester multi-tenant. Un
    // tenant-spécifique (`/<tenant-id>/`) bloque les comptes Microsoft
    // personnels (Xbox/Outlook/Skype) et les autres orgs Entra. Cf. décision
    // D4 du ticket OAuth Phase 1.
    const opts = getProviderOptions('microsoft-entra-id');
    expect(opts.issuer).toBe('https://login.microsoftonline.com/common/v2.0');
    expect(opts.tenantId).toBeUndefined();
  });

  it('session strategy = jwt avec maxAge 90 jours', () => {
    expect(authConfig.session?.strategy).toBe('jwt');
    expect(authConfig.session?.maxAge).toBe(60 * 60 * 24 * 90);
  });
});

describe('auth.config.ts — authorized callback (middleware edge gate)', () => {
  const authorized = authConfig.callbacks?.authorized;

  function makeReq(pathname: string) {
    return {
      nextUrl: { pathname },
    } as Parameters<NonNullable<typeof authorized>>[0]['request'];
  }

  it('laisse passer /login sans session', () => {
    expect(authorized?.({ auth: null, request: makeReq('/login') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(true);
  });

  it('laisse passer /api/auth/* sans session', () => {
    expect(authorized?.({ auth: null, request: makeReq('/api/auth/csrf') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(true);
  });

  it('laisse passer / (landing) sans session', () => {
    expect(authorized?.({ auth: null, request: makeReq('/') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(true);
  });

  it('laisse passer /legal (Privacy+Terms publique pour OAuth Consent)', () => {
    expect(authorized?.({ auth: null, request: makeReq('/legal') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(true);
  });

  it('bloque /dashboard sans session', () => {
    expect(authorized?.({ auth: null, request: makeReq('/dashboard') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(false);
  });

  it('autorise /dashboard avec session', () => {
    const fakeAuth = { user: { email: 'a@b' } } as unknown as Parameters<NonNullable<typeof authorized>>[0]['auth'];
    expect(authorized?.({ auth: fakeAuth, request: makeReq('/dashboard') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(true);
  });

  it('échoue fermé si Auth.js retourne un objet erreur sans vraie session', () => {
    const errorAuth = { error: 'Configuration' } as unknown as Parameters<NonNullable<typeof authorized>>[0]['auth'];

    for (const pathname of ['/dashboard', '/admin']) {
      expect(
        authorized?.({ auth: errorAuth, request: makeReq(pathname) } as Parameters<NonNullable<typeof authorized>>[0]),
      ).toBe(false);
    }
  });

  it('bloque /admin sans session', () => {
    expect(authorized?.({ auth: null, request: makeReq('/admin') } as Parameters<NonNullable<typeof authorized>>[0])).toBe(false);
  });

  // ─── Fail-open GHSA-8fpg-xm3f-6cx3 (critical) ─────────────────────────────
  //
  // Quand la config Auth.js part en erreur côté serveur, l'objet rendu par
  // `auth()` n'est PAS `null` : il est peuplé d'un objet d'erreur. Un garde-fou
  // écrit `!!auth` passe donc à `true` et s'OUVRE au lieu de se fermer. Ces
  // tests verrouillent le sens du fail : sans session utilisateur réelle, on
  // refuse, quelle que soit la forme de l'objet reçu.
  describe('fail-closed sur objet auth sans user', () => {
    const asAuth = (v: unknown) => v as Parameters<NonNullable<typeof authorized>>[0]['auth'];
    const call = (auth: unknown, path: string) =>
      authorized?.({ auth: asAuth(auth), request: makeReq(path) } as Parameters<
        NonNullable<typeof authorized>
      >[0]);

    // Forme exacte remontée par Auth.js quand la config échoue.
    const configError = { message: 'There was a problem with the server configuration.' };

    it('refuse /dashboard quand auth porte une erreur de config au lieu d’une session', () => {
      expect(call(configError, '/dashboard')).toBe(false);
    });

    it('refuse /admin quand auth porte une erreur de config au lieu d’une session', () => {
      expect(call(configError, '/admin')).toBe(false);
    });

    it('refuse un objet auth non vide mais sans user', () => {
      expect(call({}, '/dashboard')).toBe(false);
      expect(call({ expires: '2030-01-01' }, '/dashboard')).toBe(false);
    });

    it('refuse un auth dont user est null ou undefined', () => {
      expect(call({ user: null }, '/dashboard')).toBe(false);
      expect(call({ user: undefined }, '/admin')).toBe(false);
    });

    it('accepte toujours une session légitime (le correctif ne casse pas le flow)', () => {
      expect(call({ user: { email: 'client@veridian.site' } }, '/dashboard')).toBe(true);
      expect(call({ user: { email: 'client@veridian.site' } }, '/admin')).toBe(true);
    });
  });
});
