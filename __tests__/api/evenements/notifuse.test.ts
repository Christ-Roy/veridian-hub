// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ recevoir: vi.fn() }));
vi.mock('@/lib/evenements/notifuse', () => ({ recevoirNotifuse: (...a: unknown[]) => m.recevoir(...a) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { POST } from '@/app/api/evenements/notifuse/route';

const jouer = (corps: string) => POST(new NextRequest('https://app.veridian.site/api/evenements/notifuse', { method: 'POST', body: corps, headers: { 'webhook-id': 'x' } }));
beforeEach(() => {
  vi.clearAllMocks();
  m.recevoir.mockResolvedValue({ statut: 200, corps: { ok: true, effet: 'cree' } });
});

describe('POST /api/evenements/notifuse', () => {
  it('rend le verdict du traitement, jamais en cache ; le corps signé et les en-têtes sont ceux reçus', async () => {
    const r = await jouer('{"a":1}');
    expect([r.status, r.headers.get('cache-control'), await r.json()]).toEqual([200, 'no-store', { ok: true, effet: 'cree' }]);
    expect(m.recevoir.mock.calls[0][2]).toBe('{"a":1}');
    expect((m.recevoir.mock.calls[0][1] as Headers).get('webhook-id')).toBe('x');
  });
  it('un échec reste un 5xx, avec Retry-After quand la cible le demande', async () => {
    m.recevoir.mockResolvedValue({ statut: 503, corps: { error: 'crm_rate_limited' }, retryAfterS: 7 });
    const r = await jouer('{}');
    expect([r.status, r.headers.get('retry-after')]).toEqual([503, '7']);
  });
  it('trop gros : refusé sans rien lire', async () => {
    expect((await jouer(`"${'x'.repeat(16_001)}"`)).status).toBe(413);
    expect(m.recevoir).not.toHaveBeenCalled();
  });
});
