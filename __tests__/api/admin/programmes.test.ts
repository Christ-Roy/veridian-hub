// @vitest-environment node
/** GET /api/admin/programmes : admin seulement, date invalide refusée, 24 h par défaut. */
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ auth: vi.fn(), lire: vi.fn() }));
vi.mock('@/lib/admin/authenticate', () => ({ authenticateAdmin: (...a: unknown[]) => m.auth(...a) }));
vi.mock('@/lib/mcp/programmes-lus', () => ({ lireProgrammes: (...a: unknown[]) => m.lire(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { GET } from '@/app/api/admin/programmes/route';

const appel = (q = '') => GET(new NextRequest(`http://x/api/admin/programmes${q}`));
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ ok: true });
  m.lire.mockResolvedValue({ en_cours: [], aucun_client_en_cours: true });
});

describe('GET /api/admin/programmes', () => {
it('rend la lecture, sur 24 h par défaut', async () => {
  const avant = Date.now();
  const r = await appel();
  const depuis = (m.lire.mock.calls[0][1] as Date).getTime();
  expect([r.status, (await r.json()).aucun_client_en_cours, Math.round((avant - depuis) / 3600_000)]).toEqual([200, true, 24]);
});
it('refus de l\'admin ou date invalide : rien n\'est lu', async () => {
  m.auth.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: 'x' }, { status: 401 }) });
  const statuts = [(await appel()).status, (await appel('?depuis=pas-une-date')).status];
  expect([statuts, m.lire.mock.calls.length]).toEqual([[401, 400], 0]);
});
it('une date donnée est lue telle quelle', async () => {
  await appel('?depuis=2026-11-26T10:00:00Z');
  expect((m.lire.mock.calls[0][1] as Date).toISOString()).toBe('2026-11-26T10:00:00.000Z');
});
});
