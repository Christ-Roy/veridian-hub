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
  it('CRM lent : 503 en_cours avant les 10 s de la source, le travail continue et n\'est lancé qu\'une fois', async () => {
    vi.useFakeTimers();
    try {
      let finir!: (x: object) => void;
      let fini = false;
      m.recevoir.mockImplementation(() => new Promise((ok) => { finir = ok; }).then((x) => { fini = true; return x; }));
      const p = jouer('{}');
      await vi.advanceTimersByTimeAsync(8_100);
      const r = await p;
      expect([r.status, await r.json(), r.headers.get('retry-after'), fini]).toEqual([503, { error: 'en_cours' }, '30', false]);
      finir({ statut: 200, corps: {} });
      await vi.advanceTimersByTimeAsync(1);
      expect([fini, m.recevoir.mock.calls.length]).toEqual([true, 1]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('CRM lent puis en échec : dit au journal, jamais une promesse rejetée sans preneur', async () => {
    vi.useFakeTimers();
    const dit = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let casser!: (e: Error) => void;
      m.recevoir.mockImplementation(() => new Promise((_, ko) => { casser = ko; }));
      const p = jouer('{}');
      await vi.advanceTimersByTimeAsync(8_100);
      expect((await p).status).toBe(503);
      casser(new Error('base coupée'));
      await vi.advanceTimersByTimeAsync(1);
      expect(dit.mock.calls[0]).toContain('base coupée');
    } finally {
      dit.mockRestore();
      vi.useRealTimers();
    }
  });
  it('trop gros : refusé sans rien lire', async () => {
    expect((await jouer(`"${'x'.repeat(16_001)}"`)).status).toBe(413);
    expect(m.recevoir).not.toHaveBeenCalled();
  });
});
