// @vitest-environment node
/** POST /api/ia/etat (CONTRAT-HUB §5.24.1) : signé par une app à fenêtre, la personne doit être de l'organisation, l'état vient de la règle commune. */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ appel: vi.fn(), espace: vi.fn(), etat: vi.fn(), deborde: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/delegation/jeton', () => ({ verifierAppel: (...a: unknown[]) => m.appel(...a), deborde: (...a: unknown[]) => m.deborde(...a) }));
vi.mock('@/lib/ia/contexte', () => ({ espaceDe: (...a: unknown[]) => m.espace(...a) }));
vi.mock('@/lib/ia/etat-fenetre', async (o) => ({ ...(await o<object>()), etatFenetre: (...a: unknown[]) => m.etat(...a) }));

import { POST } from '@/app/api/ia/etat/route';

const U = '22222222-2222-4222-8222-222222222222';
const T = '11111111-1111-4111-8111-111111111111';
const lire = (corps: unknown = { hub_user_id: U, tenant_id: T }) => POST(new NextRequest('https://h/api/ia/etat', { method: 'POST', body: typeof corps === 'string' ? corps : JSON.stringify(corps) }));
beforeEach(() => {
  vi.clearAllMocks();
  m.appel.mockResolvedValue({ app: 'academy' });
  m.deborde.mockReturnValue(false);
  m.espace.mockResolvedValue({ id: T, slug: 's', workspaceId: null });
  m.etat.mockResolvedValue('sans_moteur');
});

describe('POST /api/ia/etat', () => {
  it('l\'app signée lit l\'état pour SA fenêtre ; seules les apps à fenêtre signent (pas le CRM) ; jamais en cache', async () => {
    const r = await lire();
    expect([r.status, await r.json(), r.headers.get('cache-control')]).toEqual([200, { etat: 'sans_moteur' }, 'no-store']);
    expect(m.appel.mock.calls[0][4]).toEqual(['academy', 'notifuse', 'prospection', 'analytics']);
    expect(m.espace.mock.calls[0]).toEqual([U, T, { par: 'personne' }, { app: 'academy', workspaceId: null }]);
    expect(m.etat.mock.calls[0][1]).toEqual({ hubUserId: U, app: 'academy', tenantId: T });
  });
  it('personne hors de l\'organisation : 404, aucun état lu', async () => {
    m.espace.mockResolvedValue(null);
    const r = await lire();
    expect([r.status, (await r.json()).error]).toEqual([404, 'espace_inconnu']);
    expect(m.etat).not.toHaveBeenCalled();
  });
  it('signature refusée, corps faux ou trop long, débit dépassé : rien n\'est lu', async () => {
    m.appel.mockResolvedValue({ statut: 401, error: 'invalid_signature' });
    expect((await lire()).status).toBe(401);
    m.appel.mockResolvedValue({ app: 'academy' });
    expect([(await lire('{')).status, (await lire({ hub_user_id: 'x', tenant_id: T })).status, (await lire('x'.repeat(2_001))).status]).toEqual([400, 400, 400]);
    m.deborde.mockReturnValue(true);
    expect((await lire()).status).toBe(429);
    expect(m.espace).not.toHaveBeenCalled();
  });
  it('chaque réponse laisse une ligne [ia][etat] : app, statut, état ou erreur ; jamais la personne ni l\'organisation', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await lire();
    m.espace.mockResolvedValue(null);
    await lire();
    m.appel.mockResolvedValue({ statut: 401, error: 'invalid_signature' });
    await lire();
    const lignes = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lignes).toEqual([
      { tag: '[ia][etat]', app: 'academy', statut: 200, quoi: 'sans_moteur' },
      { tag: '[ia][etat]', app: 'academy', statut: 404, quoi: 'espace_inconnu' },
      { tag: '[ia][etat]', app: 'inconnue', statut: 401, quoi: 'invalid_signature' },
    ]);
    expect(JSON.stringify(lignes).includes(U) || JSON.stringify(lignes).includes(T)).toBe(false);
    log.mockRestore();
  });
});
