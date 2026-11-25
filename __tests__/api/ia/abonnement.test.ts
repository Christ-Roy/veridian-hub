/**
 * Le moteur abonnement s'ouvre espace par espace (`hub ia atelier ouvrir`), fermé par défaut, et ne parle qu'à
 * l'atelier de cet espace (décision A, docs/MON-IA.md).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ contexte: vi.fn(), atelier: vi.fn(), fermee: vi.fn(() => false) }));
vi.mock('@/lib/ia/contexte', () => ({ contexteUtilisateur: () => m.contexte() }));
vi.mock('@/lib/ia/atelier', async (orig) => ({ ...(await orig<typeof import('@/lib/ia/atelier')>()), appelerAtelier: (...a: unknown[]) => m.atelier(...a) }));
vi.mock('@/lib/federation/session', () => ({ fermeeIci: async () => m.fermee(), reponseFermee: () => new Response(JSON.stringify({ error: 'organisation_fournisseur' }), { status: 403 }) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: vi.fn() }));
const t = vi.hoisted(() => ({ tenants: [] as { id: string; userId: string; metadata: unknown }[] }));
vi.mock('@/lib/prisma', () => ({ prisma: { iaBranchement: { upsert: vi.fn(), deleteMany: vi.fn() }, tenant: { findMany: async ({ where }: { where: { userId: string } }) => t.tenants.filter((x) => x.userId === where.userId) } } }));

import { POST } from '@/app/api/ia/abonnement/route';

const ROBERT = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const req = (corps: unknown) => new NextRequest('https://app.veridian.site/api/ia/abonnement', { method: 'POST', body: JSON.stringify(corps) });

beforeEach(() => {
  vi.clearAllMocks();
  // Seul l'espace de Robert a son atelier (service hub-atelier-<8 premiers caractères>).
  const dir = mkdtempSync(path.join(tmpdir(), 'ateliers-'));
  writeFileSync(path.join(dir, 'ateliers'), 'hub-atelier-359b76d5 http://atelier.test\n');
  process.env.ATELIER_PAR_TENANT_FICHIER = path.join(dir, 'ateliers');
  process.env.ATELIER_SECRET = 's'.repeat(40);
  // Robert : un espace où l'abonnement est ouvert (hub ia atelier ouvrir).
  t.tenants = [{ id: '359b76d5-bab7-4773-a889-cf4cf0248869', userId: ROBERT, metadata: { ia_atelier: { ouvert: true } } }];
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
    t.tenants = [{ id: '359b76d5-bab7-4773-a889-cf4cf0248869', userId: ROBERT, metadata: { ia_atelier: { ouvert: false } } }];
    m.contexte.mockResolvedValue({ hubUserId: ROBERT, email: 'r@x.io' });
    expect((await POST(req({ action: 'debut' }))).status).toBe(403);
  });

  it('Robert, inscrit : la connexion démarre chez Anthropic', async () => {
    m.contexte.mockResolvedValue({ hubUserId: ROBERT, email: 'r@x.io' });
    const r = await POST(req({ action: 'debut' }));
    expect(r.status).toBe(200);
    expect(m.atelier).toHaveBeenCalledWith('/connexion/debut', { hubUserId: ROBERT }, { tenantId: '359b76d5-bab7-4773-a889-cf4cf0248869' });
  });

  it('espace ouvert mais sans atelier propre : 503, l\'atelier d\'un autre n\'est jamais appelé', async () => {
    t.tenants = [{ id: 'aaaaaaaa-0000-4000-8000-000000000000', userId: ROBERT, metadata: { ia_atelier: { ouvert: true } } }];
    m.contexte.mockResolvedValue({ hubUserId: ROBERT, email: 'r@x.io' });
    const r = await POST(req({ action: 'debut' }));
    expect(r.status).toBe(503);
    expect(m.atelier).not.toHaveBeenCalled();
  });
});
