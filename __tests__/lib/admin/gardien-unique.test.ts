/**
 * Le gardien unique (`authenticateAdmin`) avec la vraie chaîne : vraie `sessionAdmin`, vrai `administrateurDe`, vraie limite de débit.
 * Seuls la session (`@/auth`) et la base (`@/lib/prisma`) sont simulés. Chaque refus d'avant reste un refus.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

const authMock = vi.hoisted(() => vi.fn());
const userMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth: (...a: unknown[]) => authMock(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => userMock(...a) } } }));

import { authenticateAdmin } from '@/lib/admin/authenticate';
import { adminApiLimiter } from '@/lib/auth/rate-limit';

/** Administrateur de plateforme connu (ADMINS_CONNUS). */
const ADMIN_HUB = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const SECRET = 'secret-de-test-tres-long-0123456789';
const ORIG_SECRET = process.env.ADMIN_SECRET;

const maintenant = () => Math.floor(Date.now() / 1000);
const sessionAdminOk = (extra: Record<string, unknown> = {}) => ({
  user: { id: 'u-admin', email: 'robert@x', authAt: maintenant(), ...extra },
});
const userAdminOk = { email: 'robert@x', supabaseUserId: ADMIN_HUB, emailVerified: new Date() };

const req = (headers: Record<string, string> = {}) =>
  new NextRequest('https://hub.test/api/admin/grant-plan', { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.7', ...headers } });

beforeEach(() => {
  authMock.mockReset();
  userMock.mockReset();
  process.env.ADMIN_SECRET = SECRET;
  adminApiLimiter.reset();
});

afterAll(() => {
  if (ORIG_SECRET === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = ORIG_SECRET;
});

describe('gardien unique : chemins acceptés', () => {
  it('clé valide : passe, sans consulter la session', async () => {
    const r = await authenticateAdmin(req({ 'x-admin-secret': SECRET }));
    expect(r.ok).toBe(true);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('session d\'un administrateur prouvé, connexion récente : passe, avec son identité', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk());
    userMock.mockResolvedValueOnce(userAdminOk);
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.admin).toEqual({ userId: 'u-admin', hubUserId: ADMIN_HUB, email: 'robert@x' });
  });
});

describe('gardien unique : refus (clé, session, identité, emprunt, fédération, preuve)', () => {
  it('clé fausse et aucune session : 401', async () => {
    authMock.mockResolvedValueOnce(null);
    const r = await authenticateAdmin(req({ 'x-admin-secret': 'mauvaise-clé-de-même-longueur-xxxxxxxxxxx' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('clé absente et aucune session : 401', async () => {
    authMock.mockResolvedValueOnce(null);
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('clé absente de la configuration (ADMIN_SECRET vide) : la clé vide ne passe jamais', async () => {
    delete process.env.ADMIN_SECRET;
    authMock.mockResolvedValueOnce(null);
    const r = await authenticateAdmin(req({ 'x-admin-secret': '' }));
    expect(r.ok).toBe(false);
  });

  it('session empruntée : refusée même si le compte emprunté est administrateur', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk({ impersonated: true }));
    userMock.mockResolvedValueOnce(userAdminOk);
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toEqual({ error: 'forbidden', message: 'Impersonated session has no admin access.' });
    }
    expect(userMock).not.toHaveBeenCalled();
  });

  it('session fédérée (ouverte par le fournisseur d\'une organisation) : refusée', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk({ federe: true }));
    userMock.mockResolvedValueOnce(userAdminOk);
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it('administrateur non prouvé (adresse non vérifiée) : 403', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk());
    userMock.mockResolvedValueOnce({ ...userAdminOk, emailVerified: null });
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it('compte connecté qui n\'est pas administrateur de plateforme : 403', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk());
    userMock.mockResolvedValueOnce({ ...userAdminOk, supabaseUserId: '11111111-2222-3333-4444-555555555555' });
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it('connexion plus vieille que 24 h : preuve ancienne, 403 recent_auth_required', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk({ authAt: maintenant() - 2 * 24 * 3600 }));
    userMock.mockResolvedValueOnce(userAdminOk);
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json()).toMatchObject({ error: 'recent_auth_required' });
  });

  it('sessionSeule : une clé valide ne passe PAS (l\'emprunt n\'accepte jamais la clé)', async () => {
    authMock.mockResolvedValueOnce(null);
    const r = await authenticateAdmin(req({ 'x-admin-secret': SECRET }), { sessionSeule: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
    expect(authMock).toHaveBeenCalled();
  });

  it('sessionSeule : une session d\'administrateur passe', async () => {
    authMock.mockResolvedValueOnce(sessionAdminOk());
    userMock.mockResolvedValueOnce(userAdminOk);
    const r = await authenticateAdmin(req(), { sessionSeule: true });
    expect(r.ok).toBe(true);
  });
});

describe('gardien unique : limite de débit (avant tout le reste)', () => {
  it('seuls les échecs comptent (27/11) : cent appels avec la bonne clé passent tous, puis une session valide aussi', async () => {
    const vus = [];
    for (let i = 0; i < 100; i++) vus.push((await authenticateAdmin(req({ 'x-admin-secret': SECRET }))).ok);
    expect(vus.every(Boolean)).toBe(true);
    authMock.mockResolvedValue(sessionAdminOk());
    userMock.mockResolvedValue(userAdminOk);
    const sessions = [];
    for (let i = 0; i < 40; i++) sessions.push((await authenticateAdmin(req())).ok);
    expect(sessions.every(Boolean)).toBe(true);
  });

  it('limite atteinte : 429 avec Retry-After, même avec la bonne clé', async () => {
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(req({ 'x-admin-secret': `faux-${i}` }));
    }
    const r = await authenticateAdmin(req({ 'x-admin-secret': SECRET }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(429);
      expect(r.response.headers.get('Retry-After')).toBeTruthy();
    }
  });

  it('limite atteinte : 429 aussi pour une session d\'administrateur valide, sans consulter la session', async () => {
    for (let i = 0; i < 30; i++) {
      authMock.mockResolvedValueOnce(null);
      await authenticateAdmin(req({ 'x-admin-secret': `faux-${i}` }));
    }
    authMock.mockClear();
    const r = await authenticateAdmin(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
    expect(authMock).not.toHaveBeenCalled();
  });
});
