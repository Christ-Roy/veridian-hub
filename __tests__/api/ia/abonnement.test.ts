/**
 * Le moteur abonnement ne s'ouvre qu'aux comptes de la liste blanche (Robert, usage interne), fermée par défaut :
 * la doc du Claude Agent SDK demande un accord préalable d'Anthropic pour tout autre usage (docs/MON-IA.md).
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ contexte: vi.fn(), atelier: vi.fn() }));
vi.mock('@/lib/ia/contexte', () => ({ contexteUtilisateur: () => m.contexte() }));
vi.mock('@/lib/ia/atelier', async (orig) => ({ ...(await orig<typeof import('@/lib/ia/atelier')>()), appelerAtelier: (...a: unknown[]) => m.atelier(...a) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: vi.fn() }));
const t = vi.hoisted(() => ({ tenants: [] as { id: string; userId: string; metadata: unknown }[] }));
vi.mock('@/lib/prisma', () => ({ prisma: { iaBranchement: { upsert: vi.fn(), deleteMany: vi.fn() }, tenant: { findMany: async ({ where }: { where: { userId: string } }) => t.tenants.filter((x) => x.userId === where.userId) } } }));

import { POST } from '@/app/api/ia/abonnement/route';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/ia/abonnement', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ATELIER_URL = 'http://atelier.test';
  process.env.ATELIER_SECRET = 's'.repeat(40);
  // Robert : un espace où l'abonnement est ouvert (hub ia atelier ouvrir).
  t.tenants = [{ id: 'tenant-robert', userId: ROBERT, metadata: { ia_atelier: { ouvert: true } } }];
  m.atelier.mockResolvedValue(new Response(JSON.stringify({ url: 'https://claude.com/cai/oauth/authorize?x' }), { status: 200 }));
});

describe('POST /api/ia/abonnement', () => {
  it('un compte sans espace ouvert ne peut pas brancher son abonnement : 403, l\'atelier n\'est pas appelé', async () => {
    m.contexte.mockResolvedValue({ hubUserId: 'autre-client', email: 'c@x.io' });
    const r = await POST(req({ action: 'debut' }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'abonnement_ferme' });
    expect(m.atelier).not.toHaveBeenCalled();
  });

  it('espace fermé (défaut) : refusé, Robert compris', async () => {
    t.tenants = [{ id: 'tenant-robert', userId: ROBERT, metadata: { ia_atelier: { ouvert: false } } }];
    m.contexte.mockResolvedValue({ hubUserId: ROBERT, email: 'r@x.io' });
    expect((await POST(req({ action: 'debut' }))).status).toBe(403);
  });

  it('Robert, inscrit : la connexion démarre chez Anthropic', async () => {
    m.contexte.mockResolvedValue({ hubUserId: ROBERT, email: 'r@x.io' });
    const r = await POST(req({ action: 'debut' }));
    expect(r.status).toBe(200);
    expect(m.atelier).toHaveBeenCalledWith('/connexion/debut', { hubUserId: ROBERT });
  });
});
