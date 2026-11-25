// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ pret: vi.fn(), demarrer: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/federation/idp', () => ({ idpPret: (...a: unknown[]) => m.pret(...a) }));
vi.mock('@/lib/federation/oidc', async (o) => ({ ...(await o<object>()), demarrer: (...a: unknown[]) => m.demarrer(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { GET } from '@/app/connexion/[slug]/route';

let ip = 0;
const aller = (slug: string, meme?: string) => GET(new NextRequest('https://0.0.0.0/x', { headers: { 'x-forwarded-for': meme ?? `203.0.113.${++ip}` } }), { params: Promise.resolve({ slug }) });
beforeEach(() => { vi.clearAllMocks(); m.pret.mockResolvedValue({ id: 'i1' }); m.demarrer.mockResolvedValue({ url: 'https://idp.client.fr/authorize?x=1', cookie: 'scelle' }); });

describe('GET /connexion/[slug]', () => {
  it('vers le fournisseur, transaction dans un cookie HttpOnly, Secure, Lax, borné au retour et à 10 min', async () => {
    const r = await aller('client');
    expect([r.status, r.headers.get('location'), m.demarrer.mock.calls[0][1]]).toEqual([303, 'https://idp.client.fr/authorize?x=1', 'https://app.veridian.site/api/auth/federation/callback']);
    expect(r.headers.get('set-cookie')).toMatch(/veridian-federation=scelle; Path=\/api\/auth\/federation\/callback;.*Max-Age=600;.*Secure; HttpOnly; SameSite=lax/i);
  });
  it('sans fournisseur, inconnue ou slug invalide : la connexion habituelle, même réponse, aucun cookie', async () => {
    m.pret.mockResolvedValue(null);
    for (const s of ['client', 'inconnu', '../etc', 'A B']) {
      const r = await aller(s);
      expect([r.status, r.headers.get('location'), r.headers.get('set-cookie')]).toEqual([303, 'https://app.veridian.site/login', null]);
    }
  });
  it('fournisseur injoignable : dit, sans détail technique', async () => {
    m.demarrer.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1'));
    const l = (await aller('client')).headers.get('location');
    expect(l).toBe('https://app.veridian.site/auth/federation?code=fournisseur_injoignable');
  });
  it('débit borné par adresse', async () => {
    const s: number[] = [];
    for (let n = 0; n < 32; n++) s.push((await aller('client', '198.51.100.9')).status);
    expect([s[29], s[31]]).toEqual([303, 429]);
  });
});
