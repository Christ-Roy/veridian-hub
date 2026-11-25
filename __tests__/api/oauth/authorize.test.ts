// @vitest-environment node
/** Le consentement d'une IA : seulement la personne, par sa propre connexion. Un accès d'IA survit à la session et suit toutes ses organisations. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), prouvee: vi.fn(), valider: vi.fn(), code: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/prisma', () => ({ prisma: { auditLog: { create: async () => undefined } } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/email-proof', () => ({ isEmailProvenForSession: () => m.prouvee() }));
vi.mock('@/lib/mcp/config', () => ({ hubIssuer: () => 'https://app.veridian.site' }));
vi.mock('@/lib/mcp/http', () => ({ lireParams: async () => ({ decision: 'autoriser' }) }));
vi.mock('@/lib/mcp/oauth', () => ({ validerDemande: (...a: unknown[]) => m.valider(...a), creerCode: (...a: unknown[]) => m.code(...a) }));

import { POST } from '@/app/api/oauth/authorize/route';

const poster = (origin = 'https://app.veridian.site') => POST(new NextRequest('https://h/x', { method: 'POST', headers: { origin } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: {} });
  m.user.mockResolvedValue({ id: 'u', supabaseUserId: 'h' });
  m.prouvee.mockResolvedValue(true);
  m.valider.mockResolvedValue({ ok: true, demande: { redirectUri: 'http://127.0.0.1:1/cb', state: 's', clientId: 'c', clientName: 'IA' } });
  m.code.mockResolvedValue('CODE');
});
describe('POST /api/oauth/authorize', () => {
  it('témoin : la personne, par sa propre connexion, reçoit le code', async () => {
    const r = await poster();
    expect([r.status, new URL(r.headers.get('location')!).searchParams.get('code'), m.code.mock.calls[0][2]]).toEqual([303, 'CODE', 'h']);
  });
  it.each([
    ['session ouverte par son organisation', () => m.auth.mockResolvedValue({ user: { federe: true } }), 403],
    ['session d\'emprunt', () => m.auth.mockResolvedValue({ user: { impersonated: true } }), 403],
    ['adresse non prouvée', () => m.prouvee.mockResolvedValue(false), 403],
    ['sans session', () => m.user.mockResolvedValue(null), 401],
  ])('%s : aucun code', async (_n, casser, statut) => {
    casser();
    expect((await poster()).status).toBe(statut);
    expect(m.code).not.toHaveBeenCalled();
  });
  it('autre origine : refusée', async () => expect((await poster('https://pirate.test')).status).toBe(403));
});
