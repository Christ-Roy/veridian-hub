import { describe, it, expect } from 'vitest';

import {
  NOTIFUSE_WORKSPACE_ID_MAX_LENGTH,
  validateWorkspaceId,
  workspaceIdDuTenant,
} from '@/lib/notifuse/workspace-id';

describe('workspaceIdDuTenant', () => {
  const [A, B] = ['3f0c1c52-9c0d-4a50-8d4e-1f2f6c1f7a01', '3f0c1c52-9c0d-4a50-8d4e-1f2f6c1f7a02'];
  it('contact@a.fr et contact@b.fr : chacun le sien ; le même à chaque rejeu, quelle que soit l\'adresse du moment', () => {
    const a = workspaceIdDuTenant(A, 'contact@a.fr');
    expect(a).not.toBe(workspaceIdDuTenant(B, 'contact@b.fr'));
    expect([workspaceIdDuTenant(A, 'contact@a.fr'), workspaceIdDuTenant(A, 'autre@ailleurs.fr')]).toEqual([a, a]);
  });
  it('accepté par Mail, sans rien de l\'adresse ; mille tenants, mille identifiants', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => workspaceIdDuTenant(`3f0c1c52-9c0d-4a50-8d4e-${String(i).padStart(12, '0')}`, 'contact@a.fr'));
    expect(new Set(ids).size).toBe(1000);
    for (const x of ids) { expect(validateWorkspaceId(x)).toEqual({ ok: true }); expect(x).toHaveLength(NOTIFUSE_WORKSPACE_ID_MAX_LENGTH); expect(x).not.toContain('contact'); }
  });
  it('un compte d\'épreuve garde le préfixe que le nettoyage compte ; un vrai compte ne l\'a jamais', () => {
    expect([workspaceIdDuTenant(A, 'e2e-sso-x@veridian.site').slice(0, 6), workspaceIdDuTenant(A, 'e2e-autre@x.fr').slice(0, 3), workspaceIdDuTenant(A, 'e2ecompagnie@x.fr')[0]]).toEqual(['e2esso', 'e2e', 'v']);
  });
});

describe('validateWorkspaceId', () => {
  it('accepte un id valide', () => {
    expect(validateWorkspaceId('acmecorp')).toEqual({ ok: true });
    expect(validateWorkspaceId('a')).toEqual({ ok: true });
    expect(validateWorkspaceId('a1b2c3d4')).toEqual({ ok: true });
  });

  it('rejette une string vide', () => {
    const r = validateWorkspaceId('');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/required/);
  });

  it('rejette un type non-string', () => {
    expect(validateWorkspaceId(null).ok).toBe(false);
    expect(validateWorkspaceId(undefined).ok).toBe(false);
    expect(validateWorkspaceId(42).ok).toBe(false);
  });

  it('rejette les majuscules', () => {
    const r = validateWorkspaceId('AcmeCorp');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lowercase/);
  });

  it('rejette les hyphens, underscores, dots', () => {
    expect(validateWorkspaceId('acme-corp').ok).toBe(false);
    expect(validateWorkspaceId('acme_corp').ok).toBe(false);
    expect(validateWorkspaceId('acme.corp').ok).toBe(false);
  });

  it('rejette si > 20 chars', () => {
    const r = validateWorkspaceId('a'.repeat(21));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/20 characters or less/);
  });

  it('accepte exactement 20 chars', () => {
    expect(validateWorkspaceId('a'.repeat(20))).toEqual({ ok: true });
  });
});
