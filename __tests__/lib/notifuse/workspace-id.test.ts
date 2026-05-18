import { describe, it, expect } from 'vitest';

import {
  NOTIFUSE_WORKSPACE_ID_MAX_LENGTH,
  validateWorkspaceId,
  workspaceIdFromEmail,
} from '@/lib/notifuse/workspace-id';

describe('workspaceIdFromEmail', () => {
  it('génère un id alphanumérique lowercase tronqué à 20 chars', () => {
    expect(workspaceIdFromEmail('john.doe+test@gmail.com')).toBe('johndoetest');
  });

  it('strip les majuscules vers lowercase', () => {
    expect(workspaceIdFromEmail('JohnDoe@example.com')).toBe('johndoe');
  });

  it('retire tout caractère non alphanumérique', () => {
    expect(workspaceIdFromEmail('user_name-with.dots@x.fr')).toBe('usernamewithdots');
  });

  it('tronque à 20 chars exactement', () => {
    const result = workspaceIdFromEmail('thisisalongusernameindeed@x.com');
    expect(result.length).toBeLessThanOrEqual(NOTIFUSE_WORKSPACE_ID_MAX_LENGTH);
    expect(result).toBe('thisisalongusernamei');
  });

  it('throw sur email avec local-part vide alphanumérique', () => {
    expect(() => workspaceIdFromEmail('___@example.com')).toThrow(/no alphanumeric/);
  });

  it('throw sur email vide', () => {
    expect(() => workspaceIdFromEmail('@example.com')).toThrow(/no alphanumeric/);
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
