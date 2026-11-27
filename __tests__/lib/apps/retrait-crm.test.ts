/**
 * Fusible du retrait au CRM (VER-203, 23/11) : un membre retiré par le Hub laissait une fiche orpheline qui bloquait
 * l'espace partagé pour tous les autres. Le Hub n'envoie `deleted` au CRM que si la personne n'est plus dans aucun espace
 * vivant ; sinon retenu, sessions coupées, trace et alerte. Doute = retenu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ audit: vi.fn(), telegram: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/admin/audit-log', () => ({ writeAuditLog: (...a: unknown[]) => m.audit(...a) }));
vi.mock('@/lib/notifications/telegram', () => ({ sendTelegramAlert: (...a: unknown[]) => m.telegram(...a) }));

import { verdictRetraitCrm } from '@/lib/apps/retrait-crm';
import { pushUserToApps } from '@/lib/identity/push-user';
import { exigeV1, exigeV2 } from '../hmac/aide-v2';

const MOI = '53245ae1-6bf8-4ec6-870f-32d75b7c0281';
const ADRESSE_CRM = 'moi-au-crm@example.org';
type Espace = { workspace_id: string; role: string };
/** Un CRM qui connaît MOI sous une autre adresse que le Hub, dans les espaces donnés. */
const crm = (espaces: Espace[] | 'illisible' | 'absent', surListe: 'ok' | 'illisible' | 'sans_moi' = 'ok') => {
  const corpsPush: unknown[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      corpsPush.push(JSON.parse(String(init.body)));
      return new Response('{"synced":true}', { status: 200 });
    }
    if (url.endsWith('/api/hub/users')) {
      if (surListe === 'illisible') return new Response('<html>', { status: 502 });
      const users = surListe === 'sans_moi' ? [{ hub_user_id: 'autre', email: 'a@b.c' }] : [{ hub_user_id: MOI, email: ADRESSE_CRM }];
      return Response.json({ users });
    }
    if (url.includes('/api/users/by-email')) {
      expect(url, 'adresse du CRM, pas celle du Hub').toContain(encodeURIComponent(ADRESSE_CRM));
      if (espaces === 'illisible') return new Response('{}', { status: 503 });
      if (espaces === 'absent') return Response.json({ found: false });
      return Response.json({ found: espaces.length > 0, workspaces: espaces });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, corpsPush };
};
const partage: Espace = { workspace_id: 'w-partage', role: 'member' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRM_API_URL', 'https://crm.test');
  vi.stubEnv('CRM_HUB_API_SECRET', 'secret');
  vi.stubEnv('NOTIFUSE_API_URL', 'https://n.test');
  vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 'secret');
  vi.stubEnv('CRM_RETRAIT_FUSIBLE', '1');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  m.audit.mockResolvedValue(undefined);
  m.telegram.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const retirer = (c: ReturnType<typeof crm>, apps: ('crm' | 'notifuse')[] = ['crm']) =>
  pushUserToApps({ hubUserId: MOI, deleted: true }, { apps, fetchImpl: c.f, retryDelaysMs: [] });

describe('fusible du retrait au CRM', () => {
  it('membre d\'un espace partagé : le retrait NE part PAS au CRM ; sessions coupées, trace et alerte', async () => {
    const c = crm([partage]);
    expect(await retirer(c)).toEqual({ crm: 'held' });
    expect(c.corpsPush).toEqual([{ hub_user_id: MOI, revoke_sessions: true }]);
    expect(JSON.stringify(c.corpsPush)).not.toContain('deleted');
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'crm.retrait.attente', targetId: MOI, payload: { raison: 'espace_vivant', espaces: 1 } }));
    expect(m.telegram).toHaveBeenCalledOnce();
    expect(JSON.stringify([m.audit.mock.calls, m.telegram.mock.calls]), 'aucune adresse').not.toContain('@');
  });

  it('seul dans aucun espace (cas habituel, espace déjà supprimé) : le retrait part', async () => {
    const c = crm('absent');
    expect(await retirer(c)).toEqual({ crm: 'ok' });
    expect(c.corpsPush).toEqual([{ hub_user_id: MOI, deleted: true }]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('inconnu du CRM : le retrait part (le CRM répond sans effet)', async () => {
    const c = crm([partage], 'sans_moi');
    expect(await retirer(c)).toEqual({ crm: 'ok' });
    expect(c.corpsPush).toEqual([{ hub_user_id: MOI, deleted: true }]);
  });

  it.each([
    ['liste des comptes illisible', crm([], 'illisible')],
    ['espaces illisibles', crm('illisible')],
  ])('doute (%s) : retenu', async (_nom, c) => {
    expect(await retirer(c)).toEqual({ crm: 'held' });
    expect(JSON.stringify(c.corpsPush)).not.toContain('deleted');
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ payload: expect.objectContaining({ raison: 'decouverte_impossible' }) }));
  });

  it('les autres apps ne sont pas touchées par le fusible', async () => {
    const c = crm([partage]);
    const r = await retirer(c, ['crm', 'notifuse']);
    expect(r).toEqual({ crm: 'held', notifuse: 'ok' });
    expect(c.corpsPush).toContainEqual({ hub_user_id: MOI, deleted: true });
  });

  it('fusible levé (CRM_RETRAIT_FUSIBLE=0) : comportement d\'origine', async () => {
    vi.stubEnv('CRM_RETRAIT_FUSIBLE', '0');
    const c = crm([partage]);
    expect(await retirer(c)).toEqual({ crm: 'ok' });
    expect(c.corpsPush).toEqual([{ hub_user_id: MOI, deleted: true }]);
  });

  it('retrait de sessions (sans suppression) : le fusible ne s\'en mêle pas', async () => {
    const c = crm([partage]);
    await pushUserToApps({ hubUserId: MOI, revokeSessions: true }, { apps: ['crm'], fetchImpl: c.f, retryDelaysMs: [] });
    expect(c.corpsPush).toEqual([{ hub_user_id: MOI, revoke_sessions: true }]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('verdict : jamais « propager » sans preuve', async () => {
    expect(await verdictRetraitCrm(MOI, { fetchImpl: crm([partage]).f })).toMatchObject({ propager: false, raison: 'espace_vivant', espaces: 1 });
    expect(await verdictRetraitCrm(MOI, { fetchImpl: crm([]).f })).toEqual({ propager: true, raison: 'aucun_espace' });
    vi.stubEnv('CRM_API_URL', '');
    expect(await verdictRetraitCrm(MOI, { fetchImpl: crm([]).f })).toMatchObject({ propager: false, raison: 'decouverte_impossible' });
  });
});

describe('lecture du CRM, version de signature', () => {
  const lire = async () => {
    const vus: { url: string; h: Record<string, string> }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      vus.push({ url, h: init?.headers as Record<string, string> });
      return Response.json({ users: [], found: false, workspaces: [] });
    }) as unknown as typeof fetch;
    await verdictRetraitCrm(MOI, { fetchImpl: f });
    return vus;
  };
  it('HMAC_V2_APPS=crm : chaque GET part en v2, lié à son chemin et à sa query', async () => {
    vi.stubEnv('HMAC_V2_APPS', 'crm');
    const vus = await lire();
    expect(vus.length).toBeGreaterThan(0);
    for (const v of vus) exigeV2(v.h, 'secret', 'GET', v.url);
  });
  it('variable absente : v1 sur `${ts}.`', async () => {
    const vus = await lire();
    expect(vus.length).toBeGreaterThan(0);
    for (const v of vus) exigeV1(v.h, 'secret');
  });
});
