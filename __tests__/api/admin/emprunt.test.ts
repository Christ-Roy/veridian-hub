// @vitest-environment node
/** Entrer chez un client (VER-263) : qui peut, ce qui se refuse, la trace d'abord. */
import { NextRequest } from 'next/server';
import { decode } from 'next-auth/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const ORG = '22222222-2222-4333-8444-555555555555';
const m = vi.hoisted(() => ({ auth: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), audit: vi.fn(), orgActive: vi.fn() }));
vi.mock('@/auth', () => ({ auth: m.auth }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: m.findUnique, findFirst: m.findFirst }, auditLog: { create: m.audit } } }));
vi.mock('@/lib/tenants/actif', () => ({ COOKIE_ACTIF: 'veridian_org', organisationActive: m.orgActive }));
vi.mock('@/lib/emprunt/entrees', () => ({ APPS_ECRAN: ['hub', 'notifuse', 'prospection', 'crm', 'analytics', 'academy'], entreeDe: (a: string) => (a === 'academy' ? null : `/vers/${a}`) }));

import { POST as entrer } from '@/app/api/admin/emprunt/route';
import { lireRetour } from '@/lib/emprunt/retour';

const BASE = 'https://app.veridian.site';
const SESSION = '__Secure-authjs.session-token';
const RETOUR = '__Secure-veridian-retour';
const maintenant = () => Math.floor(Date.now() / 1000);
const moi = (o = {}) => ({ user: { id: 'u-admin', email: 'a@v', authAt: maintenant(), ...o } });
const requete = (chemin: string, corps: unknown, o: { origin?: string | null; cookie?: string } = {}) =>
  new NextRequest(`${BASE}${chemin}`, { method: 'POST', body: corps === undefined ? undefined : JSON.stringify(corps), headers: { ...(o.origin === null ? {} : { origin: o.origin ?? BASE }), cookie: o.cookie ?? `${SESSION}=la-mienne; veridian_org=mon-org`, 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` } });
const e = (corps: object = {}, o = {}) => entrer(requete('/api/admin/emprunt', { hubUserId: CLIENT, app: 'crm', ...corps }, o));

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(process.env, { AUTH_SECRET: 'secret-de-test-assez-long-pour-chiffrer', NEXTAUTH_URL: BASE, NEXT_PUBLIC_SITE_URL: BASE, PLATFORM_ADMINS: ADMIN });
  m.auth.mockImplementation(async () => moi());
  m.findUnique.mockResolvedValue({ email: 'robert@v', supabaseUserId: ADMIN, emailVerified: new Date() });
  m.findFirst.mockResolvedValue({ id: 'u-client', email: 'client@c', name: 'C', image: null, supabaseUserId: CLIENT });
  m.audit.mockResolvedValue({ id: 'emprunt-1' });
  m.orgActive.mockImplementation(async (_d: unknown, _h: string, s: string) => s);
});

describe('entrer', () => {
  it('pose la session du client, bornée, et met la mienne de côté ; le journal dit qui, chez qui, pourquoi', async () => {
    const r = await e({ tenantId: ORG, raison: ' il  appelle ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, url: '/vers/crm', emprunt: 'emprunt-1' });
    const c = r.cookies.get(SESSION)!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 3600 });
    expect(await decode({ token: c.value, secret: process.env.AUTH_SECRET!, salt: SESSION })).toMatchObject({ uid: 'u-client', impersonated: true, impersonatedBy: ADMIN, empruntId: 'emprunt-1' });
    expect(r.cookies.get(RETOUR)).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict', path: '/api/auth/emprunt' });
    expect(await lireRetour(r.cookies.get(RETOUR)!.value, 'emprunt-1')).toEqual({ empruntId: 'emprunt-1', session: 'la-mienne', org: 'mon-org' });
    expect(r.cookies.get('veridian_org')?.value).toBe(ORG);
    expect(m.audit.mock.calls[0][0].data).toMatchObject({ action: 'admin.impersonate.start', actor: 'admin:robert@v', targetId: 'u-client', payload: { par: ADMIN, hubUserId: CLIENT, raison: 'il appelle', app: 'crm', tenantId: ORG, via: 'ecran' } });
  });

  it('sans organisation choisie : la mienne ne suit pas chez le client', async () => {
    const r = await e();
    expect([r.status, r.cookies.get('veridian_org')?.value]).toEqual([200, '']);
    expect(m.orgActive).not.toHaveBeenCalled();
  });

  it('la clé d\'administration n\'ouvre pas cette porte : une personne, jamais un secret', async () => {
    process.env.ADMIN_SECRET = 'une-cle-d-administration';
    m.auth.mockResolvedValue(null);
    const q = requete('/api/admin/emprunt', { hubUserId: CLIENT, app: 'crm' });
    q.headers.set('x-admin-secret', 'une-cle-d-administration');
    expect((await entrer(q)).status).toBe(401);
  });

  const refus: [string, () => Promise<Response>, number, string][] = [
    ['autre origine', () => e({}, { origin: 'https://mechant.fr' }), 403, 'forbidden_origin'],
    ['sans origine', () => e({}, { origin: null }), 403, 'forbidden_origin'],
    ['pas connecté', () => { m.auth.mockResolvedValue(null); return e(); }, 401, 'unauthorized'],
    ['pas administrateur, même à l\'adresse de Robert', () => { m.findUnique.mockResolvedValue({ email: 'robert.brunon@veridian.site', supabaseUserId: CLIENT, emailVerified: new Date() }); return e(); }, 403, 'forbidden'],
    ['administrateur à l\'adresse jamais prouvée', () => { m.findUnique.mockResolvedValue({ email: 'robert@v', supabaseUserId: ADMIN, emailVerified: null }); return e(); }, 403, 'forbidden'],
    ['session fédérée de l\'administrateur', () => { m.auth.mockResolvedValue(moi({ federe: true })); return e(); }, 403, 'forbidden'],
    ['déjà en emprunt', () => { m.auth.mockResolvedValue(moi({ impersonated: true })); return e(); }, 403, 'forbidden'],
    ['connexion de plus de 24 h', () => { m.auth.mockResolvedValue(moi({ authAt: maintenant() - 90_000 })); return e(); }, 403, 'recent_auth_required'],
    ['app inconnue', () => e({ app: 'stripe' }), 400, 'invalid_body'],
    ['compte inconnu', () => { m.findFirst.mockResolvedValue(null); return e(); }, 404, 'user_not_found'],
    ['soi-même', () => { m.findFirst.mockResolvedValue({ id: 'u-admin', supabaseUserId: ADMIN }); return e(); }, 409, 'soi_meme'],
    ['un autre administrateur', () => { m.findFirst.mockResolvedValue({ id: 'u-2', supabaseUserId: ADMIN }); return e(); }, 403, 'cible_admin'],
    ['une organisation qui n\'est pas la sienne', () => { m.orgActive.mockResolvedValue(null); return e({ tenantId: ORG }); }, 409, 'organisation_indisponible'],
    ['une app non branchée', () => e({ app: 'academy' }), 409, 'not_configured'],
    ['ma session illisible', () => e({}, { cookie: 'x=y' }), 409, 'session_illisible'],
    ['le journal ne s\'écrit pas', () => { m.audit.mockRejectedValue(new Error('panne')); return e(); }, 503, 'journal_indisponible'],
  ];
  it.each(refus)('refusé : %s, et aucun cookie', async (_n, f, statut, code) => {
    const r = await f();
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([statut, code]);
    expect(r.headers.getSetCookie()).toEqual([]);
  });
});
