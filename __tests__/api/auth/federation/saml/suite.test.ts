// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ idp: vi.fn(), ouvrir: vi.fn(), conclure: vi.fn() }));
vi.mock('@/lib/federation/conclure', () => ({ idpDe: () => m.idp(), conclure: (...a: unknown[]) => m.conclure(...a), sortieDe: () => ({ refus: (c: string) => ({ headers: new Headers({ location: `refus:${c}` }) }) }) }));
vi.mock('@/lib/federation/saml', async (o) => ({ ...(await o<object>()), ouvrirSuite: () => m.ouvrir() }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { GET } from '@/app/api/auth/federation/saml/suite/route';

const venir = () => GET(new NextRequest('https://h/x', { headers: { cookie: 'veridian-federation-saml-suite=c' } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.ouvrir.mockReturnValue({ transaction: { idp: 'i', state: 's' }, identite: { sub: 'x' } });
  m.idp.mockResolvedValue({ id: 'i', protocole: 'saml' });
  m.conclure.mockResolvedValue(NextResponse.json({ ok: true }));
});

describe('GET', () => {
  it('la même conclusion que l\'OIDC, avec l\'identité scellée', async () => {
    expect((await venir()).status).toBe(200);
    expect(m.conclure.mock.calls[0].slice(2, 5)).toEqual([{ id: 'i', protocole: 'saml' }, { idp: 'i', state: 's' }, { sub: 'x' }]);
  });
  it('fournisseur fermé ou devenu OIDC entre-temps : rien', async () => {
    m.idp.mockResolvedValue({ id: 'i', protocole: 'oidc' });
    expect((await venir()).headers.get('location')).toBe('refus:organisation_indisponible');
    expect(m.conclure).not.toHaveBeenCalled();
  });
  it('périmée ou forgée : rien', async () => {
    m.ouvrir.mockReturnValue(null);
    expect((await venir()).headers.get('location')).toBe('refus:demande_expiree');
    expect(m.conclure).not.toHaveBeenCalled();
  });
});
