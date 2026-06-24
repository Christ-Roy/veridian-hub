/**
 * Tests pour lib/admin/require-admin.ts — `requireAdmin`.
 *
 * Wrapper d'auth des routes admin "simples" du Hub (14 routes : grant-plan,
 * delete-tenant, notifuse suspend/resume/delete, tenants link/unlink, ...).
 * Deux chemins acceptés :
 *   - header `x-admin-secret` === `ADMIN_SECRET` (script / cron)
 *   - session Auth.js dont l'email est whitelisté (`isPlatformAdmin`)
 * Renvoie `null` si autorisé, sinon une NextResponse 401/403.
 *
 * Sabotage-test mental (chaque assertion verrouille un invariant sécu) :
 *   - retirer le guard `adminSecret &&` → un client qui n'envoie PAS de header
 *     passerait quand ADMIN_SECRET n'est pas configuré (null === undefined ?
 *     non, mais '' === '' oui) → test "ADMIN_SECRET absent" rouge
 *   - inverser `=== adminSecret` → wrong secret accepté → test rouge
 *   - retirer le check `isPlatformAdmin` → n'importe quelle session passe → test rouge
 *   - retirer le check `!session?.user` → pas de session = pas de 401 → test rouge
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

const authMock = vi.fn();
const isPlatformAdminMock = vi.fn();

vi.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));
vi.mock('@/lib/admin/check-admin', () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdminMock(...a),
}));

import { requireAdmin } from '@/lib/admin/require-admin';

const ORIG_SECRET = process.env.ADMIN_SECRET;

beforeEach(() => {
  authMock.mockReset();
  isPlatformAdminMock.mockReset();
  process.env.ADMIN_SECRET = 'super-secret-for-tests';
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});

const makeReq = (headers: Record<string, string> = {}) =>
  new NextRequest('http://x/api/admin/foo', {
    method: 'POST',
    headers,
  });

describe('requireAdmin — chemin x-admin-secret', () => {
  it('autorise (null) quand x-admin-secret matche ADMIN_SECRET', async () => {
    const res = await requireAdmin(makeReq({ 'x-admin-secret': 'super-secret-for-tests' }));
    expect(res).toBeNull();
    // Le chemin secret court-circuite : on ne doit même pas consulter la session.
    expect(authMock).not.toHaveBeenCalled();
  });

  it('rejette (401) quand x-admin-secret est faux ET pas de session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await requireAdmin(makeReq({ 'x-admin-secret': 'wrong' }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});

describe('requireAdmin — chemin session Auth.js', () => {
  it('rejette (401) quand pas de header ET pas de session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await requireAdmin(makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('rejette (401) quand session existe mais sans user', async () => {
    authMock.mockResolvedValueOnce({});
    const res = await requireAdmin(makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('rejette (403) quand session user présent mais NON admin', async () => {
    authMock.mockResolvedValueOnce({ user: { email: 'random@x', id: 'u1' } });
    isPlatformAdminMock.mockReturnValueOnce(false);
    const res = await requireAdmin(makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it('autorise (null) quand session user est admin', async () => {
    authMock.mockResolvedValueOnce({ user: { email: 'admin@x', id: 'u1' } });
    isPlatformAdminMock.mockReturnValueOnce(true);
    const res = await requireAdmin(makeReq());
    expect(res).toBeNull();
  });
});

describe('requireAdmin — garde-fous de configuration (sécu)', () => {
  it("GARDE-FOU : ADMIN_SECRET non configuré + header vide → NE bypasse PAS (tombe sur la session)", async () => {
    // Si ADMIN_SECRET n'est pas posé côté serveur, le chemin secret doit être
    // totalement inerte (le `adminSecret &&` court-circuite). Un client qui
    // n'envoie pas de header ne doit jamais être autorisé par défaut.
    delete process.env.ADMIN_SECRET;
    authMock.mockResolvedValueOnce(null);
    const res = await requireAdmin(makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("GARDE-FOU : ADMIN_SECRET non configuré + header présent → NE bypasse PAS", async () => {
    // Pire cas : ADMIN_SECRET absent mais l'attaquant envoie un x-admin-secret
    // (même vide). Le guard `adminSecret &&` doit empêcher tout match.
    delete process.env.ADMIN_SECRET;
    authMock.mockResolvedValueOnce(null);
    const res = await requireAdmin(makeReq({ 'x-admin-secret': '' }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("le secret correct mais une session non-admin → autorisé quand même (secret prime)", async () => {
    // Le chemin secret est volontairement prioritaire : un cron sans session
    // valide passe par le header. On verrouille que la présence d'une session
    // non-admin ne casse PAS l'accès par secret.
    authMock.mockResolvedValueOnce({ user: { email: 'random@x' } });
    isPlatformAdminMock.mockReturnValueOnce(false);
    const res = await requireAdmin(makeReq({ 'x-admin-secret': 'super-secret-for-tests' }));
    expect(res).toBeNull();
  });
});
