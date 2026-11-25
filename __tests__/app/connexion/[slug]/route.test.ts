// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ user: vi.fn(async (): Promise<unknown> => null), membre: vi.fn(async () => false), reliee: vi.fn(async () => true), pret: vi.fn(), demarrer: vi.fn(), auth: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => m.auth() }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/email-proof', () => ({ isEmailProvenForSession: async () => true }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 86_400, isAuthRecent: (a?: number) => a === 1 }));
vi.mock('@/lib/adresses/federation', () => ({ membreVivant: () => m.membre() }));
vi.mock('@/lib/federation/prouver', () => ({ dejaReliee: () => m.reliee() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/federation/idp', () => ({ idpPret: (...a: unknown[]) => m.pret(...a) }));
vi.mock('@/lib/federation/oidc', async (o) => ({ ...(await o<object>()), demarrer: (...a: unknown[]) => m.demarrer(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { GET } from '@/app/connexion/[slug]/route';

let ip = 0;
const aller = (slug: string, meme?: string) => GET(new NextRequest('https://0.0.0.0/x', { headers: { 'x-forwarded-for': meme ?? `203.0.113.${++ip}` } }), { params: Promise.resolve({ slug }) });
beforeEach(() => { vi.clearAllMocks(); m.auth.mockResolvedValue(null); m.pret.mockResolvedValue({ id: 'i1', tenantId: 'T' }); m.demarrer.mockResolvedValue({ url: 'https://idp.client.fr/authorize?x=1', cookie: 'scelle' }); });

describe('GET /connexion/[slug]', () => {
  it('vers le fournisseur, transaction dans un cookie HttpOnly, Secure, Lax, borné au retour et à 10 min', async () => {
    const r = await aller('client');
    expect([r.status, r.headers.get('location'), m.demarrer.mock.calls[0][1]]).toEqual([303, 'https://idp.client.fr/authorize?x=1', 'https://app.veridian.site/api/auth/federation/callback']);
    expect(r.headers.get('set-cookie')).toMatch(/veridian-porte-pause=1;/);
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
  it('membre connecté par ses propres moyens : sa session passe par le fournisseur ; première fois sans preuve récente : elle se reconnecte d\'abord', async () => {
    m.auth.mockResolvedValue({ user: { authAt: 0 } });
    m.user.mockResolvedValue({ id: 'U', supabaseUserId: 'h' });
    m.membre.mockResolvedValue(true);
    await aller('client');
    expect(m.demarrer.mock.calls[0].at(-1)).toEqual({ userId: 'U' });
    m.reliee.mockResolvedValueOnce(false);
    expect((await aller('client')).headers.get('location')).toBe('https://app.veridian.site/login?reauth=1&callbackUrl=%2Fconnexion%2Fclient');
    m.membre.mockResolvedValue(false);
    m.demarrer.mockClear();
    await aller('client');
    expect(m.demarrer.mock.calls[0].at(-1)).toBeUndefined();
    m.user.mockResolvedValue(null);
  });
  it('déjà entrée par CETTE organisation : droit au tableau de bord ; par une autre, ou session ordinaire : chez le fournisseur', async () => {
    m.auth.mockResolvedValue({ user: { federe: true, federeOrg: 'T' } });
    expect((await aller('client')).headers.get('location')).toBe('https://app.veridian.site/dashboard');
    for (const user of [{ federe: true, federeOrg: 'AUTRE' }, {}]) {
      m.auth.mockResolvedValue({ user });
      expect((await aller('client')).headers.get('location')).toContain('idp.client.fr');
    }
  });
  it('débit borné par adresse', async () => {
    const s: number[] = [];
    for (let n = 0; n < 32; n++) s.push((await aller('client', '198.51.100.9')).status);
    expect([s[29], s[31]]).toEqual([303, 429]);
  });
});
