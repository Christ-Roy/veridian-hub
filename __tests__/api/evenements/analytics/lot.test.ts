// @vitest-environment node
/** POST /api/evenements/analytics/lot : le verdict du traitement, jamais en cache ; plus de 1 Mo refusé avant tout traitement. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ recevoir: vi.fn() }));
vi.mock('@/lib/evenements/visite', () => ({ VISITES_MAX_OCTETS: 1_000_000, recevoirVisites: (...a: unknown[]) => m.recevoir(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { dynamic, POST, runtime } from '@/app/api/evenements/analytics/lot/route';

const jouer = (corps: string) => POST(new NextRequest('https://app.veridian.site/api/evenements/analytics/lot', { method: 'POST', body: corps, headers: { 'x-veridian-app': 'analytics' } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.recevoir.mockResolvedValue({ statut: 200, corps: { acceptes: 2, doublons: 0, ignores: [] } });
});

describe('POST /api/evenements/analytics/lot', () => {
  it('rend le verdict du traitement, sans cache ; le corps et les en-têtes reçus lui sont passés tels quels', async () => {
    const r = await jouer('{"lot":1}');
    expect([r.status, r.headers.get('cache-control'), await r.json(), m.recevoir.mock.calls[0][2], (m.recevoir.mock.calls[0][1] as Headers).get('x-veridian-app')]).toEqual([200, 'no-store', { acceptes: 2, doublons: 0, ignores: [] }, '{"lot":1}', 'analytics']);
  });
  it('un refus garde son code et son Retry-After ; plus de 1 Mo : 413 sans traitement', async () => {
    m.recevoir.mockResolvedValueOnce({ statut: 429, corps: { error: 'rate_limited' }, retryAfterS: 60 });
    const a = await jouer('{}');
    const b = await jouer('x'.repeat(1_000_001));
    expect([a.status, a.headers.get('retry-after'), b.status, m.recevoir.mock.calls.length]).toEqual([429, '60', 413, 1]);
  });
  it('jamais rendue statique ni mise en cache : runtime Node, rendu dynamique', () => {
    expect([runtime, dynamic]).toEqual(['nodejs', 'force-dynamic']);
  });
});
