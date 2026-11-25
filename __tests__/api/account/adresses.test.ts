// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '@/lib/auth/rate-limit';

const m = vi.hoisted(() => ({ user: vi.fn(), ligne: vi.fn(), emprunt: vi.fn(), recent: vi.fn(), demander: vi.fn(), confirmer: vi.fn(), detacher: vi.fn(), lister: vi.fn(), pour: vi.fn(), demarrer: vi.fn(), promouvoir: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: (...a: unknown[]) => m.ligne(...a) } } }));
vi.mock('@/lib/auth/get-user', () => ({ getCurrentUser: () => m.user() }));
vi.mock('@/lib/auth/recent-auth', () => ({ PREUVE_COMPTE_S: 1, denyIfImpersonated: () => m.emprunt(), denyUnlessRecentAuth: () => m.recent() }));
vi.mock('@/lib/adresses', () => ({ demanderCode: (...a: unknown[]) => m.demander(...a), confirmerCode: (...a: unknown[]) => m.confirmer(...a), detacher: (...a: unknown[]) => m.detacher(...a), adressesProuvees: (...a: unknown[]) => m.lister(...a) }));

vi.mock('@/lib/adresses/federation', () => ({ fournisseurPour: (...a: unknown[]) => m.pour(...a) }));
vi.mock('@/lib/adresses/promotion', () => ({ promouvoir: (...a: unknown[]) => m.promouvoir(...a) }));
vi.mock('@/lib/federation/oidc', () => ({ CHEMIN_RETOUR: '/api/auth/federation/callback', COOKIE_FEDERATION: 'veridian-federation', TRANSACTION_S: 600, demarrer: (...a: unknown[]) => m.demarrer(...a) }));
vi.mock('@/lib/mail/oauth-cookies', () => ({ getHubBaseUrl: () => new URL('https://app.veridian.site') }));

import { GET, POST } from '@/app/api/account/adresses/route';

const poster = async (corps: unknown) => { const r = await POST(new NextRequest('https://h/x', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) })); return [r.status, await r.json().catch(() => null)]; };
beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue({ id: 'u' });
  m.ligne.mockResolvedValue({ id: 'u', email: 'Jean@gmail.com', emailVerified: new Date() });
  m.emprunt.mockResolvedValue(null);
  m.recent.mockResolvedValue(null);
  m.demander.mockResolvedValue('demande');
  m.confirmer.mockResolvedValue('ajoutee');
  m.detacher.mockResolvedValue(true);
  vi.spyOn(RateLimiter.prototype, 'enforce').mockReturnValue({ ok: true } as never);
  m.pour.mockResolvedValue({ id: 'i1' });
  m.demarrer.mockResolvedValue({ url: 'https://idp.client.test/authorize?x', cookie: 'scelle' });
  m.promouvoir.mockResolvedValue({ promue: 'pro@client.fr', appsEnEchec: [] });
  m.lister.mockResolvedValue(['jean@gmail.com', 'pro@client.fr']);
});
const rien = () => expect([m.demander, m.confirmer, m.detacher, m.pour, m.promouvoir].map((f) => f.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);

describe('GET adresses', () => {
  it('les siennes, sans la principale dans les secondaires ; sans session : rien', async () => {
    expect(await (await GET()).json()).toEqual({ principale: 'Jean@gmail.com', principale_prouvee: true, secondaires: ['pro@client.fr'] });
    m.user.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
describe('POST adresses', () => {
  it('les trois gestes, pour la personne connectée, adresse normalisée', async () => {
    expect(await poster({ geste: 'demander', email: ' Pro@Client.FR ' })).toEqual([200, { ok: true }]);
    expect(m.demander.mock.calls[0].slice(1)).toEqual([expect.objectContaining({ id: 'u' }), 'pro@client.fr']);
    expect(await poster({ geste: 'confirmer', email: 'pro@client.fr', code: '123456' })).toEqual([200, { ok: true }]);
    expect(await poster({ geste: 'detacher', email: 'pro@client.fr' })).toEqual([200, { ok: true }]);
  });
  it('adresse principale non prouvée : aucun droit, pas même celui d\'en ajouter', async () => {
    m.ligne.mockResolvedValue({ id: 'u', email: 'j@x.fr', emailVerified: null });
    expect(await poster({ geste: 'demander', email: 'a@x.fr' })).toEqual([403, { error: 'email_not_verified' }]);
    rien();
  });
  it('sans session, session d\'emprunt, preuve ancienne : rien', async () => {
    m.user.mockResolvedValue(null);
    expect((await poster({ geste: 'demander', email: 'a@x.fr' }))[0]).toBe(401);
    m.user.mockResolvedValue({ id: 'u' });
    m.emprunt.mockResolvedValue(new Response('', { status: 403 }));
    expect((await poster({ geste: 'demander', email: 'a@x.fr' }))[0]).toBe(403);
    m.emprunt.mockResolvedValue(null);
    m.recent.mockResolvedValue(new Response('', { status: 401 }));
    for (const g of ['promouvoir', 'federer']) expect((await poster({ geste: g, email: 'a@x.fr' }))[0], g).toBe(401);
    expect((await poster({ geste: 'confirmer', email: 'a@x.fr', code: '123456' }))[0]).toBe(401);
    rien();
  });
  it('corps faux, champ de plus, code mal formé, geste inconnu : 400, rien', async () => {
    for (const c of ['{', {}, { geste: 'demander', email: 'x' }, { geste: 'demander', email: 'a@x.fr', userId: 'v' }, { geste: 'confirmer', email: 'a@x.fr', code: '12345' }, { geste: 'promouvoir', email: 'a@x.fr', user_id: 'v' }, { geste: 'federer' }, { geste: 'fusionner', email: 'a@x.fr' }]) expect((await poster(c))[0], JSON.stringify(c)).toBe(400);
    rien();
  });
  it('refus traduits : débit, code faux, prise, inconnue', async () => {
    m.demander.mockResolvedValue('trop');
    expect(await poster({ geste: 'demander', email: 'a@x.fr' })).toEqual([429, { error: 'rate_limited' }]);
    m.confirmer.mockResolvedValue('code_invalide');
    expect(await poster({ geste: 'confirmer', email: 'a@x.fr', code: '123456' })).toEqual([400, { error: 'code_invalide' }]);
    m.confirmer.mockResolvedValue('prise');
    expect(await poster({ geste: 'confirmer', email: 'a@x.fr', code: '123456' })).toEqual([409, { error: 'prise' }]);
    m.detacher.mockResolvedValue(false);
    expect((await poster({ geste: 'detacher', email: 'a@x.fr' }))[0]).toBe(404);
  });
  it('prouver par son organisation : la transaction scellée est pour elle et cette adresse ; inconnu, muet : rien de posé', async () => {
    const r = await POST(new NextRequest('https://h/x', { method: 'POST', body: JSON.stringify({ geste: 'federer', email: 'Pro@client.fr' }) }));
    expect(await r.json()).toEqual({ ok: true, url: 'https://idp.client.test/authorize?x' });
    expect(r.headers.get('set-cookie')).toMatch(/veridian-federation=scelle; Path=\/api\/auth\/federation\/callback.*HttpOnly/i);
    expect(m.demarrer.mock.calls[0]).toEqual([{ id: 'i1' }, 'https://app.veridian.site/api/auth/federation/callback', undefined, { userId: 'u', email: 'pro@client.fr' }]);
    m.pour.mockResolvedValue(null);
    expect(await poster({ geste: 'federer', email: 'a@x.fr' })).toEqual([404, { error: 'domaine_non_federe' }]);
    m.pour.mockResolvedValue({ id: 'i1' });
    m.demarrer.mockRejectedValue(new Error('refus'));
    vi.spyOn(console, 'error').mockReturnValue();
    expect(await poster({ geste: 'federer', email: 'a@x.fr' })).toEqual([503, { error: 'fournisseur_injoignable' }]);
  });
  it('promouvoir : dit la nouvelle principale et qu\'il faut se reconnecter ; chaque refus a son code, l\'app est nommée ; débit', async () => {
    expect(await poster({ geste: 'promouvoir', email: 'Pro@client.fr' })).toEqual([200, { ok: true, principale: 'pro@client.fr', reconnect: true, apps_failed: [] }]);
    for (const [refus, statut] of [['not_found', 404], ['domaine_federe', 403], ['preuve_perdue', 403], ['app_non_reliee', 409], ['app_indisponible', 503], ['app_refuse', 409], ['prise', 409], ['email_not_verified', 403]] as const) {
      m.promouvoir.mockResolvedValue({ refus });
      expect(await poster({ geste: 'promouvoir', email: 'a@x.fr' })).toEqual([statut, { error: refus }]);
    }
    m.promouvoir.mockResolvedValue({ refus: 'app_par_adresse', apps: ['crm'] });
    expect(await poster({ geste: 'promouvoir', email: 'a@x.fr' })).toEqual([409, { error: 'app_par_adresse', apps: ['crm'] }]);
    vi.mocked(RateLimiter.prototype.enforce).mockReturnValue({ ok: false } as never);
    for (const g of ['promouvoir', 'federer']) expect(await poster({ geste: g, email: 'a@x.fr' })).toEqual([429, { error: 'rate_limited' }]);
  });
});
