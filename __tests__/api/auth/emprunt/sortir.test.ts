// @vitest-environment node
/** Sortir de chez un client (VER-263) : la session rendue, à elle seule. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const m = vi.hoisted(() => ({ auth: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), audit: vi.fn(), orgActive: vi.fn() }));
vi.mock('@/auth', () => ({ auth: m.auth }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: m.findUnique, findFirst: m.findFirst }, auditLog: { create: m.audit } } }));
vi.mock('@/lib/tenants/actif', () => ({ COOKIE_ACTIF: 'veridian_org', organisationActive: m.orgActive }));
vi.mock('@/lib/emprunt/entrees', () => ({ APPS_ECRAN: ['hub', 'notifuse', 'prospection', 'crm', 'analytics', 'academy'], entreeDe: (a: string) => (a === 'academy' ? null : `/vers/${a}`) }));

import { POST as sortir } from '@/app/api/auth/emprunt/sortir/route';
import { scellerRetour } from '@/lib/emprunt/retour';

const BASE = 'https://app.veridian.site';
const SESSION = '__Secure-authjs.session-token';
const RETOUR = '__Secure-veridian-retour';
const maintenant = () => Math.floor(Date.now() / 1000);
const moi = (o = {}) => ({ user: { id: 'u-admin', email: 'a@v', authAt: maintenant(), ...o } });
const requete = (chemin: string, corps: unknown, o: { origin?: string | null; cookie?: string } = {}) =>
  new NextRequest(`${BASE}${chemin}`, { method: 'POST', body: corps === undefined ? undefined : JSON.stringify(corps), headers: { ...(o.origin === null ? {} : { origin: o.origin ?? BASE }), cookie: o.cookie ?? `${SESSION}=la-mienne; veridian_org=mon-org`, 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` } });

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(process.env, { AUTH_SECRET: 'secret-de-test-assez-long-pour-chiffrer', NEXTAUTH_URL: BASE, NEXT_PUBLIC_SITE_URL: BASE, PLATFORM_ADMINS: ADMIN });
  m.auth.mockImplementation(async () => moi());
  m.findUnique.mockResolvedValue({ email: 'robert@v', supabaseUserId: ADMIN, emailVerified: new Date() });
  m.findFirst.mockResolvedValue({ id: 'u-client', email: 'client@c', name: 'C', image: null, supabaseUserId: 'h-client' });
  m.audit.mockResolvedValue({ id: 'emprunt-1' });
  m.orgActive.mockImplementation(async (_d: unknown, _h: string, s: string) => s);
});

describe('sortir', () => {
  const chez = (o = {}) => ({ user: { id: 'u-client', impersonated: true, impersonatedBy: ADMIN, empruntId: 'emprunt-1', authAt: maintenant(), ...o } });
  const s = async (o: { origin?: string; retour?: string } = {}) => sortir(requete('/api/auth/emprunt/sortir', undefined, { origin: o.origin, cookie: `${SESSION}=du-client${o.retour ? `; ${RETOUR}=${o.retour}` : ''}` }));

  it('rend ma session et mon organisation, efface le retour, écrit la fin', async () => {
    m.auth.mockResolvedValue(chez());
    const r = await s({ retour: await scellerRetour({ empruntId: 'emprunt-1', session: 'la-mienne', org: 'mon-org' }) });
    expect([r.status, new URL(r.headers.get('location')!).pathname]).toEqual([303, '/dashboard/admin/clients']);
    expect([r.cookies.get(SESSION)?.value, r.cookies.get('veridian_org')?.value, r.cookies.get(RETOUR)?.value]).toEqual(['la-mienne', 'mon-org', '']);
    expect(new URL(r.headers.get('location')!).search, 'sur la fiche du client quitté').toBe(`?u=${ADMIN}&sortie=emprunt-1`);
    expect(m.audit.mock.calls[0][0].data).toMatchObject({ action: 'admin.impersonate.end', payload: { emprunt: 'emprunt-1', retour: true } });
  });
  it('le retour d\'un AUTRE emprunt, ou forgé : rien n\'est rendu, la session du client tombe', async () => {
    m.auth.mockResolvedValue(chez());
    for (const retour of [await scellerRetour({ empruntId: 'emprunt-2', session: 'la-mienne', org: null }), 'forge', undefined]) {
      const r = await s({ retour });
      expect(r.cookies.get(SESSION)?.value).toBe('');
      expect(r.headers.get('location')).toContain('/login');
    }
  });
  it('déconnecté ou expiré : le retour ne rend rien à personne', async () => {
    m.auth.mockResolvedValue(null);
    const r = await s({ retour: await scellerRetour({ empruntId: 'emprunt-1', session: 'la-mienne', org: null }) });
    expect(r.cookies.get(SESSION)).toBeUndefined();
    expect(r.cookies.get(RETOUR)?.value).toBe('');
  });
  it('une session ordinaire n\'y perd rien ; une autre origine est refusée', async () => {
    m.auth.mockResolvedValue(moi());
    expect((await s()).cookies.get(SESSION)).toBeUndefined();
    expect((await s({ origin: 'https://mechant.fr' })).status).toBe(403);
  });
});
