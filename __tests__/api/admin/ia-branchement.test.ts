/**
 * Ranger au coffre la clé d'un compte depuis le bastion (`hub ia brancher`) : admin seulement, adresse prouvée,
 * clé chiffrée, jamais rendue ni journalisée, et une clé refusée par son fournisseur n'est pas rangée.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ upsert: vi.fn(), findUnique: vi.fn(), audit: vi.fn(), verifier: vi.fn() }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/ia/verifier-cle', () => ({ verifierCle: (...a: unknown[]) => m.verifier(...a) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => m.findUnique(...a) },
    iaBranchement: { upsert: (...a: unknown[]) => m.upsert(...a), findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 1 })) },
  },
}));

import { POST } from '@/app/api/admin/ia/branchement/route';
import { dechiffrer } from '@/lib/ia/coffre';

const CLE = 'sk-ant-api03-' + 'x'.repeat(40) + 'FIN9';
const SECRET = 'a'.repeat(40);
const req = (corps: unknown, secret: string | null = SECRET) =>
  new NextRequest('https://app.veridian.site/api/admin/ia/branchement', {
    method: 'POST',
    headers: secret ? { 'x-admin-secret': secret } : {},
    body: JSON.stringify(corps),
  });

const espion = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = SECRET;
  process.env.VAULT_ENC_KEY = 'k'.repeat(48);
  m.findUnique.mockResolvedValue({ email: 'r@veridian.site', supabaseUserId: 'hub-robert', emailVerified: new Date() });
  m.upsert.mockImplementation(async ({ create }: { create: Record<string, string> }) => ({ ...create, updatedAt: new Date() }));
  m.verifier.mockResolvedValue({ etat: 'reconnue', statut: 200 });
});
afterEach(() => espion.mockClear());

describe('POST /api/admin/ia/branchement', () => {
  it('sans secret admin : 401, rien de rangé', async () => {
    const r = await POST(req({ email: 'r@veridian.site', fournisseur: 'anthropic', cle: CLE }, null));
    expect(r.status).toBe(401);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('range la clé chiffrée au compte, ne rend que sa fin, ne la journalise nulle part', async () => {
    const r = await POST(req({ email: 'R@veridian.site', fournisseur: 'anthropic', cle: CLE }));
    const texte = await r.text();
    expect(r.status).toBe(200);
    expect(texte).not.toContain(CLE);
    expect(JSON.parse(texte).branchement.cleFin).toBe('FIN9');
    const { create } = m.upsert.mock.calls[0][0] as { create: { hubUserId: string; cleScellee: string } };
    expect(create.hubUserId).toBe('hub-robert');
    expect(create.cleScellee).not.toContain(CLE);
    expect(dechiffrer(create.cleScellee)).toBe(CLE);
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain(CLE);
    expect(JSON.stringify(espion.mock.calls)).not.toContain(CLE);
  });

  it('corps invalide : la réponse ne cite pas la valeur reçue', async () => {
    const r = await POST(req({ email: 'pas-une-adresse', fournisseur: 'anthropic', cle: CLE }));
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(CLE);
  });

  it('adresse non prouvée : 403, rien de rangé', async () => {
    m.findUnique.mockResolvedValue({ email: 'r@veridian.site', supabaseUserId: 'hub-robert', emailVerified: null });
    expect((await POST(req({ email: 'r@veridian.site', fournisseur: 'anthropic', cle: CLE }))).status).toBe(403);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('clé refusée par le fournisseur à la vérification : 422, rien de rangé', async () => {
    m.verifier.mockResolvedValue({ etat: 'refusee', statut: 401 });
    const r = await POST(req({ email: 'r@veridian.site', fournisseur: 'anthropic', cle: CLE, verifier: true }));
    expect(r.status).toBe(422);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it('vérification non aboutie : la clé est rangée, l\'état est dit', async () => {
    m.verifier.mockResolvedValue({ etat: 'non_abouti', statut: null });
    const r = await POST(req({ email: 'r@veridian.site', fournisseur: 'anthropic', cle: CLE, verifier: true }));
    expect(r.status).toBe(200);
    expect((await r.json()).verification.etat).toBe('non_abouti');
  });
});
