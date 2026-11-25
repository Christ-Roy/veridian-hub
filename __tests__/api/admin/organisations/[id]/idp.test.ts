// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ admin: vi.fn(), poser: vi.fn(), audit: vi.fn(), idp: vi.fn(), retirer: vi.fn() }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: (...a: unknown[]) => m.admin(...a) }));
vi.mock('@/lib/admin/audit-log', async (o) => ({ ...(await o<object>()), writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: { tenantIdp: { findUnique: () => m.idp(), deleteMany: () => m.retirer() }, tenant: { findFirst: async () => ({ slug: 'client' }) } } }));
vi.mock('@/lib/federation/idp', async (o) => ({ ...(await o<object>()), poserIdp: (...a: unknown[]) => m.poser(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { DELETE, GET, PUT } from '@/app/api/admin/organisations/[id]/idp/route';

const T = '11111111-1111-4111-8111-111111111111';
const ctx = (id = T) => ({ params: Promise.resolve({ id }) });
const R = { issuer: 'https://idp.client.fr', client_id: 'c', client_secret: 'tres-secret', domaines: ['client.fr'] };
const req = (corps?: unknown) => new NextRequest('https://h/x', { method: 'PUT', body: JSON.stringify(corps) });
beforeEach(() => {
  vi.clearAllMocks();
  m.admin.mockResolvedValue(null);
  m.poser.mockResolvedValue({ id: 'i1' });
  m.retirer.mockResolvedValue({ count: 1 });
  m.idp.mockResolvedValue({ id: 'i1', issuer: R.issuer, clientId: 'c', secretChiffre: 'v1.x', domaines: ['client.fr'], creationAuto: false, actif: true, poseLe: new Date(0) });
});

describe('GET idp', () => {
  it('rend le réglage, le lien de connexion et l\'adresse de retour, jamais le secret', async () => {
    const r = await GET(new NextRequest('https://h/x'), ctx());
    const j = await r.json();
    expect([r.status, j.connexion, j.retour]).toEqual([200, 'https://app.veridian.site/connexion/client', 'https://app.veridian.site/api/auth/federation/callback']);
    expect(JSON.stringify(j)).not.toMatch(/secret|v1\.x/);
  });
  it('sans droit, ou identifiant faux', async () => {
    expect((await GET(new NextRequest('https://h/x'), ctx('x'))).status).toBe(400);
    m.admin.mockResolvedValue(new Response('', { status: 403 }));
    expect((await GET(new NextRequest('https://h/x'), ctx())).status).toBe(403);
  });
});
describe('PUT idp', () => {
  it('pose, note sans secret, rend la vue', async () => {
    const r = await PUT(req(R), ctx());
    expect([r.status, JSON.stringify(await r.json()).includes('tres-secret'), JSON.stringify(m.audit.mock.calls).includes('tres-secret')]).toEqual([200, false, false]);
    expect(m.poser.mock.calls[0][1]).toMatchObject({ tenantId: T, reglage: { domaines: ['client.fr'], creation_auto: false, actif: true } });
  });
  it('SAML, et un alias lisible ; alias faux refusé ; absent, il est gardé', async () => {
    const S = { protocole: 'saml', issuer: 'urn:c', sso_url: 'https://idp.client.fr/sso', certificat: 'A'.repeat(120) };
    expect((await PUT(req({ ...S, alias: 'client-fr' }), ctx())).status).toBe(200);
    expect(m.poser.mock.calls[0][1]).toMatchObject({ alias: 'client-fr', reglage: { protocole: 'saml' } });
    expect((await PUT(req({ ...R, alias: '../x' }), ctx())).status).toBe(400);
    await PUT(req(R), ctx());
    expect(m.poser.mock.calls.at(-1)![1].alias).toBeUndefined();
  });
  it('corps faux : 400 ; refus : 409, 404 ; sans droit : 403 ; rien n\'est noté', async () => {
    expect((await PUT(req({ ...R, plus: 1 }), ctx())).status).toBe(400);
    m.poser.mockResolvedValue({ refus: 'domaine_public' });
    expect((await PUT(req(R), ctx())).status).toBe(409);
    m.poser.mockResolvedValue({ refus: 'tenant_introuvable' });
    expect((await PUT(req(R), ctx())).status).toBe(404);
    m.admin.mockResolvedValue(new Response('', { status: 403 }));
    expect((await PUT(req(R), ctx())).status).toBe(403);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
describe('DELETE idp', () => {
  it('ferme la porte et le note ; rien à fermer : rien de noté', async () => {
    expect(await (await DELETE(req({}), ctx())).json()).toEqual({ retires: 1 });
    m.retirer.mockResolvedValue({ count: 0 });
    await DELETE(req({}), ctx());
    expect(m.audit).toHaveBeenCalledTimes(1);
  });
  it('sans droit, identifiant faux : rien', async () => {
    expect((await DELETE(req({}), ctx('x'))).status).toBe(400);
    m.admin.mockResolvedValue(new Response('', { status: 403 }));
    expect((await DELETE(req({}), ctx())).status).toBe(403);
    expect(m.retirer).not.toHaveBeenCalled();
  });
});
