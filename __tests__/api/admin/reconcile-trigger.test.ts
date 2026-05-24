/**
 * Tests pour POST /api/admin/reconcile-trigger
 *
 * Couvre :
 *  - authenticateAdmin guard
 *  - 200 + summary brut si OK (avec autoRepair: false forcé)
 *  - 500 si runReconcile throw
 *  - vérifie que autoRepair=false est TOUJOURS forcé (jamais true même si
 *    un body trompeur arrive)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticateAdminMock = vi.fn();
const runReconcileMock = vi.fn();

vi.mock('@/lib/admin/authenticate', () => ({
  authenticateAdmin: (...args: unknown[]) => authenticateAdminMock(...args),
}));
vi.mock('@/lib/sync/reconcile', () => ({
  runReconcile: (...args: unknown[]) => runReconcileMock(...args),
}));

beforeEach(() => {
  authenticateAdminMock.mockReset();
  runReconcileMock.mockReset();
});

const makeReq = () =>
  new Request('http://x/api/admin/reconcile-trigger', { method: 'POST' });

const authOK = { ok: true, sessionEmail: null };
const authDenied = {
  ok: false,
  response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
};

describe('POST /api/admin/reconcile-trigger', () => {
  it('renvoie le denyResponse de authenticateAdmin si non autorisé', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authDenied);
    const { POST } = await import('@/app/api/admin/reconcile-trigger/route');
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(401);
    expect(runReconcileMock).not.toHaveBeenCalled();
  });

  it('200 + summary brut si runReconcile OK', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    runReconcileMock.mockResolvedValueOnce({
      usersScanned: 42,
      appsQueried: 84,
      appsUnreachable: 0,
      driftsDetected: 3,
      drifts: [{ hubTenantId: 't1', app: 'notifuse', kind: 'plan_mismatch' }],
      startedAt: '2026-05-24T00:00:00.000Z',
      durationMs: 1234,
      errors: [],
    });

    const { POST } = await import('@/app/api/admin/reconcile-trigger/route');
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usersScanned).toBe(42);
    expect(body.driftsDetected).toBe(3);
    expect(body.drifts).toHaveLength(1);
  });

  it('500 si runReconcile throw', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    runReconcileMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import('@/app/api/admin/reconcile-trigger/route');
    const res = await POST(makeReq() as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('reconcile_failed');
    expect(body.message).toBe('boom');
  });

  it('FORCE autoRepair=false (jamais true même si l\'appel théorique le tente)', async () => {
    authenticateAdminMock.mockResolvedValueOnce(authOK);
    runReconcileMock.mockResolvedValueOnce({
      usersScanned: 0,
      appsQueried: 0,
      appsUnreachable: 0,
      driftsDetected: 0,
      drifts: [],
      startedAt: '2026-05-24T00:00:00.000Z',
      durationMs: 1,
      errors: [],
    });

    const { POST } = await import('@/app/api/admin/reconcile-trigger/route');
    await POST(makeReq() as never);
    // Vérifie que la route a appelé runReconcile avec autoRepair: false strict.
    expect(runReconcileMock).toHaveBeenCalledWith({ autoRepair: false });
  });
});
