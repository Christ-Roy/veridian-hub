// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ idp: vi.fn(), terminer: vi.fn(), ouvrir: vi.fn() }));
vi.mock('@/lib/federation/conclure', () => ({ idpDe: () => m.idp(), sortieDe: () => ({ vers: (c: string) => new (require('next/server').NextResponse)(null, { status: 303, headers: { location: c } }), refus: (c: string) => new (require('next/server').NextResponse)(null, { status: 303, headers: { location: `refus:${c}` } }) }) }));
vi.mock('@/lib/federation/oidc', async (o) => ({ ...(await o<object>()), ouvrir: () => m.ouvrir() }));
vi.mock('@/lib/federation/saml', async (o) => ({ ...(await o<object>()), terminerSaml: (...a: unknown[]) => m.terminer(...a), scellerSuite: () => 'suite' }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { POST } from '@/app/api/auth/federation/saml/route';

const poster = (corps = 'SAMLResponse=UEhY', entetes: Record<string, string> = {}) => POST(new NextRequest('https://0.0.0.0/x', { method: 'POST', body: corps, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'veridian-federation-saml=c', ...entetes } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.ouvrir.mockReturnValue({ idp: 'i' });
  m.idp.mockResolvedValue({ id: 'i', protocole: 'saml' });
  m.terminer.mockResolvedValue({ sub: 's', email: null, emailNie: true, nom: null });
  vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: true } as never);
});

describe('POST', () => {
  it('vérifiée : l\'identité scellée, dans un cookie Lax de 60 s borné à la suite ; rien d\'autre n\'est décidé ici', async () => {
    const r = await poster();
    expect([r.status, r.headers.get('location'), m.terminer.mock.calls[0][2]]).toEqual([303, '/api/auth/federation/saml/suite', 'UEhY']);
    expect(r.headers.get('set-cookie')).toMatch(/veridian-federation-saml-suite=suite; Path=\/api\/auth\/federation\/saml\/suite;.*Max-Age=60;.*Secure; HttpOnly; SameSite=lax/i);
  });
  it.each([
    ['sans transaction (initiée par le fournisseur)', () => m.ouvrir.mockReturnValue(null), 'demande_expiree'],
    ['fournisseur fermé', () => m.idp.mockResolvedValue(null), 'organisation_indisponible'],
    ['fournisseur OIDC', () => m.idp.mockResolvedValue({ id: 'i', protocole: 'oidc' }), 'organisation_indisponible'],
    ['réponse refusée', () => m.terminer.mockRejectedValue(new Error('signature')), 'reponse_refusee'],
    ['identifiant qui ne dure pas', () => m.terminer.mockRejectedValue(new Error('identifiant_non_durable')), 'identifiant_non_durable'],
  ])('%s : refusé, aucune suite', async (_n, casser, code) => {
    casser();
    const r = await poster();
    expect([r.headers.get('location'), r.headers.get('set-cookie')]).toEqual([`refus:${code}`, null]);
  });
  it('sans réponse : refusée', async () => expect((await poster('x=1')).headers.get('location')).toBe('refus:reponse_refusee'));
  it('trop gros, trop souvent', async () => {
    expect((await poster('SAMLResponse=x', { 'content-length': '500000' })).status).toBe(413);
    vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: false } as never);
    expect((await poster()).status).toBe(429);
  });
});
