/**
 * Tests pour lib/admin/check-admin.ts — `isPlatformAdmin`.
 *
 * Gardien d'autorisation CRITIQUE : c'est la whitelist qui décide qui est
 * platform-admin du Hub. Consommé directement par `requireAdmin`,
 * `authenticateAdmin`, `lib/auth/impersonation.ts` et la route
 * `notifuse/magic-link`. Un bug ici = élévation de privilège silencieuse.
 *
 * Pourquoi ces tests (sabotage-test mental) :
 *   - retirer le `?.email` guard → un user null/sans email crash ou passe → test rouge
 *   - retirer le `.toLowerCase()` → un admin avec casse différente perd l'accès → test rouge
 *   - inverser la condition `includes` → tout le monde devient admin → test rouge
 *
 * `ADMIN_EMAILS` est lu au moment de l'import du module (constante top-level).
 * On teste donc le comportement avec la valeur d'env effective au chargement
 * (défaut `brunon5robert@gmail.com`), et la robustesse de la fonction pure.
 */

import { describe, it, expect } from 'vitest';

import { isPlatformAdmin, ADMIN_EMAILS } from '@/lib/admin/check-admin';

describe('isPlatformAdmin — gardien whitelist platform-admin', () => {
  it('refuse un user null', () => {
    expect(isPlatformAdmin(null)).toBe(false);
  });

  it('refuse un user undefined', () => {
    expect(isPlatformAdmin(undefined)).toBe(false);
  });

  it('refuse un user sans email (email absent)', () => {
    expect(isPlatformAdmin({})).toBe(false);
  });

  it('refuse un user avec email null', () => {
    expect(isPlatformAdmin({ email: null })).toBe(false);
  });

  it('refuse un user avec email vide', () => {
    expect(isPlatformAdmin({ email: '' })).toBe(false);
  });

  it('refuse un email NON whitelisté', () => {
    expect(isPlatformAdmin({ email: 'random@attacker.com' })).toBe(false);
  });

  it('accepte un email whitelisté (1er de la liste effective)', () => {
    // On lit le 1er admin de la whitelist effective au chargement du module
    // plutôt que de hardcoder — robuste à un override ADMIN_EMALS futur.
    const known = ADMIN_EMAILS[0];
    expect(known).toBeTruthy();
    expect(isPlatformAdmin({ email: known })).toBe(true);
  });

  it('est insensible à la casse de l\'email (UPPERCASE accepté)', () => {
    const known = ADMIN_EMAILS[0];
    expect(isPlatformAdmin({ email: known.toUpperCase() })).toBe(true);
  });

  it('est insensible à la casse mixte (MiXeD case accepté)', () => {
    const known = ADMIN_EMAILS[0];
    const mixed = known
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    expect(isPlatformAdmin({ email: mixed })).toBe(true);
  });

  it('ne fait PAS de match partiel (substring d\'un admin refusé)', () => {
    // Garde-fou : un email qui CONTIENT un admin mais n'est pas exactement lui
    // ne doit jamais passer (pas de .includes() côté string).
    const known = ADMIN_EMAILS[0];
    expect(isPlatformAdmin({ email: `${known}.attacker.com` })).toBe(false);
    expect(isPlatformAdmin({ email: `prefix${known}` })).toBe(false);
  });
});

describe('ADMIN_EMAILS — la whitelist est non vide et normalisée lowercase', () => {
  it('contient au moins un admin', () => {
    expect(ADMIN_EMAILS.length).toBeGreaterThan(0);
  });

  it('toutes les entrées sont en lowercase (normalisation au chargement)', () => {
    for (const email of ADMIN_EMAILS) {
      expect(email).toBe(email.toLowerCase());
    }
  });
});
