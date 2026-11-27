// @vitest-environment node
/** POST /api/admin/alerte-test : info par défaut ; « critique » seulement sur demande, libellé ESSAI, pour éprouver la règle Grafana. */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const garde = vi.hoisted(() => ({ ok: true as boolean }));
vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: async () => (garde.ok ? { ok: true } : { ok: false, response: new Response(null, { status: 401 }) }),
}));

import { POST } from '@/app/api/admin/alerte-test/route';

const req = (corps?: string) => new NextRequest('https://hub.test/api/admin/alerte-test', { method: 'POST', body: corps });
let lignes: string[] = [];
beforeEach(() => {
  garde.ok = true;
  lignes = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lignes.push(String(l)));
});
afterEach(() => vi.restoreAllMocks());

describe('alerte-test', () => {
  it('sans corps : une ligne info, jamais critique', async () => {
    const r = await POST(req());
    const l = JSON.parse(lignes[0]);
    expect([r.status, l.flux, l.gravite, l.evenement, l.service]).toEqual([200, 'alerte', 'info', 'hub.alerte_test', 'hub']);
  });
  it('{"gravite":"critique"} : critique, impact client, événement préfixé ESSAI-', async () => {
    const r = await POST(req('{"gravite":"critique"}'));
    const l = JSON.parse(lignes[0]);
    expect([r.status, l.gravite, l.impact, l.evenement.startsWith('ESSAI-'), /ESSAI/.test(l.message)]).toEqual([200, 'critique', 'client', true, true]);
  });
  it('une autre gravité, un champ de plus ou un corps illisible : 400, rien d\'écrit', async () => {
    for (const c of ['{"gravite":"erreur"}', '{"gravite":"critique","impact":"interne"}', 'pas du json']) {
      expect((await POST(req(c))).status, c).toBe(400);
    }
    expect(lignes).toEqual([]);
  });
  it('non admin : refusé, rien d\'écrit', async () => {
    garde.ok = false;
    expect((await POST(req('{"gravite":"critique"}'))).status).toBe(401);
    expect(lignes).toEqual([]);
  });
});
