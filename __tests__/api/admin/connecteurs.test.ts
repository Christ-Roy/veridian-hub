// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ refus: null as Response | null, clients: [] as any[], vus: [] as any[], desinscrire: vi.fn(), sonder: vi.fn(), audits: [] as any[] }));
vi.mock('@/lib/admin/require-admin', () => ({ requireAdmin: async () => m.refus }));
vi.mock('@/lib/admin/audit-log', () => ({ resolveActor: () => 'admin', writeAuditLog: async (_d: unknown, l: unknown) => { m.audits.push(l); } }));
vi.mock('@/lib/connecteurs/oauth', () => ({ desinscrire: (...a: unknown[]) => m.desinscrire(...a), inscrireEtSonder: (...a: unknown[]) => m.sonder(...a) }));
vi.mock('@/lib/connecteurs/porte', () => ({ retourConnecteur: () => 'https://app.veridian.site/api/connecteurs/retour' }));
vi.mock('@/lib/prisma', () => ({ prisma: { connecteurClient: { findMany: async () => m.clients }, connecteurOutilVu: { findMany: async () => m.vus } } }));

import { DELETE, GET, POST } from '@/app/api/admin/connecteurs/route';

const req = (corps?: object) => new NextRequest('https://app.veridian.site/api/admin/connecteurs', corps ? { method: 'DELETE', body: JSON.stringify(corps) } : undefined);
beforeEach(() => { m.refus = null; m.audits.length = 0; m.desinscrire.mockReset().mockResolvedValue('effacee'); });

describe('GET', () => {
  it('inscriptions sans secret, outils à relire', async () => {
    m.clients = [{ connecteur: 'notion', retour: 'r', clientId: 'id', gestionChiffre: 'v1.secret', creeLe: 'd' }, { connecteur: 'linear', retour: 'r', clientId: 'id2', gestionChiffre: null, creeLe: 'd' }];
    m.vus = [{ connecteur: 'notion', nom: 'x', empreinte: 'e', definition: '{}' }];
    const t = await (await GET(req())).text();
    expect([t.includes('v1.secret'), JSON.parse(t).inscriptions.map((i: any) => i.effacable), JSON.parse(t).outils_a_relire.length]).toEqual([false, [true, false], 1]);
  });
});
describe('DELETE', () => {
  it('efface, avec sa trace ; non confirmé, inconnu : rien', async () => {
    expect((await DELETE(req({ connecteur: 'notion', retour: 'r', confirm: true }))).status).toBe(200);
    expect([m.desinscrire.mock.calls[0][1].cle, m.audits.length]).toEqual(['notion', 1]);
    for (const x of [{ connecteur: 'notion', retour: 'r' }, { connecteur: 'stripe', retour: 'r', confirm: true }, { connecteur: 'notion', confirm: true }]) expect((await DELETE(req(x))).status).toBe(400);
    expect(m.desinscrire).toHaveBeenCalledTimes(1);
  });
  it.each([['absente', 404], ['sans_jeton', 409], ['echec', 409]])('%s : dit', async (issue, statut) => {
    m.desinscrire.mockResolvedValue(issue);
    expect((await DELETE(req({ connecteur: 'notion', retour: 'r', confirm: true }))).status).toBe(statut);
  });
});
it('non admin : refus partout', async () => {
  m.refus = new Response('{}', { status: 403 });
  expect([(await GET(req())).status, (await DELETE(req({ connecteur: 'notion', retour: 'r', confirm: true }))).status, m.desinscrire.mock.calls.length]).toEqual([403, 403, 0]);
});

describe('POST', () => {
  const poster = (corps: object) => POST(new NextRequest('https://app.veridian.site/api/admin/connecteurs', { method: 'POST', body: JSON.stringify(corps) }));
  it('un candidat ou un service du registre : inscrit et sondé vers NOTRE retour, avec sa trace ; inconnu ou d\'argent : 400 ; non admin : refusé', async () => {
    m.sonder.mockReset().mockResolvedValue({ inscrit: true, client_id: 'c', methode: 'none', ecran: 'ecran', detail: 'HTTP 302' });
    const r = await poster({ connecteur: 'atlassian' });
    expect([r.status, (await r.json()).ecran, m.sonder.mock.calls[0][1].cle, m.sonder.mock.calls[0][2], m.audits.length]).toEqual([200, 'ecran', 'atlassian', 'https://app.veridian.site/api/connecteurs/retour', 1]);
    expect((await poster({ connecteur: 'notion' })).status).toBe(200);
    for (const x of [{ connecteur: 'stripe' }, { connecteur: 'canva' }, { connecteur: 'vercel' }, { connecteur: 'figma' }, { connecteur: 'neon' }, {}]) expect((await poster(x)).status).toBe(400);
    m.sonder.mockRejectedValueOnce(new Error('sans_enregistrement'));
    expect((await poster({ connecteur: 'gdrive' })).status).toBe(502);
    m.refus = new Response(null, { status: 401 });
    expect((await poster({ connecteur: 'atlassian' })).status).toBe(401);
  });
});
