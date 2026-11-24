// @vitest-environment node
/** POST /api/mcp : la porte publique, et la seule qui offre le mode programme. */
import { readFileSync } from 'node:fs';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ acces: vi.fn(), traiter: vi.fn() }));
vi.mock('@/lib/mcp/oauth', () => ({ verifierAcces: (...a: unknown[]) => m.acces(...a) }));
vi.mock('@/lib/mcp/porte', () => ({ traiter: (...a: unknown[]) => m.traiter(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/mcp/route';

import { parcourir } from '../contrat/source';

const req = (corps: string, auth = 'Bearer j') => new NextRequest('https://app.veridian.site/api/mcp', { method: 'POST', body: corps, headers: auth ? { authorization: auth } : {} });
beforeEach(() => {
  vi.clearAllMocks();
  m.acces.mockResolvedValue({ hubUserId: `u-${Math.random()}` });
  m.traiter.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });
});

describe('POST /api/mcp', () => {
  it('sans jeton ou jeton refusé : 401, rien de traité', async () => {
    expect((await POST(req('{}', ''))).status).toBe(401);
    m.acces.mockResolvedValue(null);
    const r = await POST(req('{}'));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata');
    expect(m.traiter).not.toHaveBeenCalled();
  });

  it('offre le mode programme', async () => {
    expect((await POST(req('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))).status).toBe(200);
    expect(m.traiter.mock.calls[0][3]).toEqual({ programme: true });
  });

  it('illisible, lot ou trop gros : refusé ; notification : 202', async () => {
    expect((await POST(req('{'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect((await POST(req(`"${'x'.repeat(1_000_001)}"`))).status).toBe(413);
    expect(m.traiter).not.toHaveBeenCalled();
    m.traiter.mockResolvedValue(null);
    expect((await POST(req('{"jsonrpc":"2.0","method":"notifications/initialized"}'))).status).toBe(202);
  });
});

it('aucun autre appelant de la porte n\'offre le mode programme (Mon IA approuve outil par outil)', () => {
  const fichiers = ['app', 'lib'].flatMap((d) => parcourir(d)).filter((f) => /\.tsx?$/.test(f));
  expect(fichiers.length).toBeGreaterThan(100);
  expect(fichiers.filter((f) => /programme:\s*true/.test(readFileSync(f, 'utf8'))).map((f) => f.replace(/^.*\/(app|lib)\//, '$1/'))).toEqual(['app/api/mcp/route.ts']);
});
