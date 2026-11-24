// @vitest-environment node
/** Relevé d'appartenance (VER-245 a) : il classe, il n'écrit rien, et ce qu'il n'a pas pu lire n'est jamais un zéro. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/check-admin', () => ({ isPlatformAdmin: (u: { email: string }) => u.email === 'patron@veridian.example' }));

import { classer, releverAppartenance, type HubTenant, type HubUser } from '@/lib/sync/appartenance';
import type { TenantSnapshot } from '@/lib/sync/types';

const u = (id: string, email: string, prouve = true): HubUser => ({ supabaseUserId: id, email, emailVerified: prouve ? new Date() : null });
const t = (id: string, userId: string, o: Partial<HubTenant> = {}): HubTenant => ({ id, userId, status: 'active', notifuseWorkspaceSlug: null, metadata: null, ...o });
const s = (workspaceId: string, o: Partial<TenantSnapshot> = {}): TenantSnapshot => ({ app: 'notifuse', workspaceId, observedAt: '', ...o });
const HUB = {
  users: [u('u-prop', 'Prop@client.fr'), u('u-col', 'col@client.fr'), u('u-flou', 'flou@client.fr', false), u('u-patron', 'patron@veridian.example'), u('u-membre', 'membre@client.fr')],
  tenants: [t('T1', 'u-prop', { notifuseWorkspaceSlug: 'esp' }), t('T2', 'u-col', { status: 'suspended', metadata: { crm: { workspace_id: 'w2' } } })],
  membres: [{ tenantId: 'T1', userId: 'u-membre' }],
};
const lu = (email: string, snaps: TenantSnapshot[], hub_user_id: string | null = null) => ({ humain: { email, hub_user_id }, snapshots: snaps });
const casDe = (r: ReturnType<typeof classer>, email: string) => r.espaces.flatMap((e) => e.membres).find((m) => m.email === email)?.cas;

describe('classer', () => {
  it('chaque humain a son cas', () => {
    const r = classer('notifuse', [
      lu('prop@client.fr', [s('esp', { role: 'owner' })], 'u-prop'),
      lu('membre@client.fr', [s('esp')]),
      lu('col@client.fr', [s('esp', { role: 'owner' })]),
      lu('flou@client.fr', [s('esp')]),
      lu('patron@veridian.example', [s('esp', { role: 'owner' })], 'u-patron'),
      lu('robert@veridian.site', [s('esp')]),
      lu('etranger@ailleurs.fr', [s('esp')]),
      lu('seul@ailleurs.fr', []),
    ], HUB);
    expect([casDe(r, 'prop@client.fr'), casDe(r, 'membre@client.fr'), casDe(r, 'col@client.fr'), casDe(r, 'flou@client.fr'), casDe(r, 'patron@veridian.example'), casDe(r, 'robert@veridian.site'), casDe(r, 'etranger@ailleurs.fr')])
      .toEqual(['dans_les_deux', 'dans_les_deux', 'jonction', 'adresse_non_prouvee', 'operateur', 'operateur', 'inconnu']);
    expect(r.comptes).toEqual({ dans_les_deux: 2, jonction: 1, operateur: 2, adresse_non_prouvee: 1, inconnu: 1, espace_non_relie: 0 });
    expect(r).toMatchObject({ sansEspace: 1, absents: 0 });
    expect(r.espaces[0]).toMatchObject({ espace: 'esp', hubTenantId: 'T1', lien: 'hub', partielle: true, tenantSuspendu: false });
  });

  it('une adresse du Hub non prouvée ne donne jamais une jonction ; le lien du rebond, si', () => {
    expect(casDe(classer('notifuse', [lu('flou@client.fr', [s('esp')])], HUB), 'flou@client.fr')).toBe('adresse_non_prouvee');
    expect(casDe(classer('notifuse', [lu('flou@client.fr', [s('esp')], 'u-flou')], HUB), 'flou@client.fr')).toBe('jonction');
  });

  it('un identifiant inconnu du Hub ne vaut rien : c\'est l\'adresse prouvée, ou inconnu', () => {
    expect(casDe(classer('notifuse', [lu('col@client.fr', [s('esp')], 'u-forge')], HUB), 'col@client.fr')).toBe('jonction');
    expect(casDe(classer('notifuse', [lu('x@y.fr', [s('esp')], 'u-forge')], HUB), 'x@y.fr')).toBe('inconnu');
  });

  it('le lien d\'un espace : app, Hub, les deux, divergent ; un divergent ou un tenant mort ne relie rien', () => {
    const lien = (w: string, hubTenantLink?: string | null) => {
      const e = classer('notifuse', [lu('col@client.fr', [s(w, { hubTenantLink })])], HUB).espaces[0];
      return [e.lien, e.hubTenantId, e.membres[0].cas];
    };
    expect(lien('esp')).toEqual(['hub', 'T1', 'jonction']);
    expect(lien('esp', 'T1')).toEqual(['les_deux', 'T1', 'jonction']);
    expect(lien('esp', 'T2')).toEqual(['divergent', null, 'espace_non_relie']);
    expect(lien('autre', 'T1')).toEqual(['app', 'T1', 'jonction']);
    expect(lien('autre', 'T-mort')).toEqual(['aucun', null, 'espace_non_relie']);
    expect(lien('autre')).toEqual(['aucun', null, 'espace_non_relie']);
  });

  it('au Hub et pas dans l\'app : nommé ; un tenant suspendu est dit ; un espace supprimé ne compte pas', () => {
    const r = classer('crm', [lu('prop@client.fr', [s('w2', { app: 'crm' }), s('mort', { app: 'crm', status: 'deleted' })], 'u-prop')], HUB);
    expect(r.espaces).toHaveLength(1);
    expect(r.espaces[0]).toMatchObject({ hubTenantId: 'T2', tenantSuspendu: true, absents: ['u-col'], partielle: false });
    expect(r.absents).toBe(1);
  });
});

it('un propriétaire non prouvé, présent dans l\'app, est non prouvé et pas « absent »', () => {
  const hub = { ...HUB, tenants: [t('T3', 'u-flou', { notifuseWorkspaceSlug: 'e3' })] };
  const r = classer('notifuse', [lu('flou@client.fr', [s('e3', { role: 'owner' })])], hub);
  expect(r).toMatchObject({ absents: 0, comptes: { adresse_non_prouvee: 1 } });
  expect(r.espaces[0]).toMatchObject({ absents: [], partielle: true });
});

describe('releverAppartenance', () => {
  const ecriture = vi.fn();
  const interdit = new Proxy({}, { get: (_c, k) => (k === 'findMany' ? undefined : ecriture) });
  const db = { user: { ...interdit, findMany: async () => HUB.users }, tenant: { findMany: async () => HUB.tenants }, tenantMember: { findMany: async () => HUB.membres } } as never;
  const app = (humains: unknown, parEmail: (email: string) => Response | Promise<Response>) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      return url.includes('/api/hub/users') ? (humains instanceof Response ? humains : Response.json({ users: humains })) : parEmail(new URL(url).searchParams.get('email')!);
    }) as unknown as typeof fetch;
  const espace = Response.json.bind(Response, { found: true, workspaces: [{ workspace_id: 'esp', role: 'owner' }] });
  beforeEach(() => {
    vi.stubEnv('NOTIFUSE_API_URL', 'https://notifuse.test');
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', 's');
  });

  it('lit chaque humain, sans les comptes de test', async () => {
    const f = app([{ email: 'col@client.fr' }, { email: 'e2e-x@veridian.site' }], () => espace());
    const r = await releverAppartenance(db, 'notifuse', f);
    expect(r).toMatchObject({ etat: 'ok', humains: 1, nonLus: [], comptes: { jonction: 1 } });
  });

  it('un humain dont l\'app ne rend pas les espaces : NON ABOUTI, nommé, le reste est rendu', async () => {
    const f = app([{ email: 'col@client.fr' }, { email: 'prop@client.fr' }], (e) => (e.startsWith('prop') ? new Response('', { status: 500 }) : espace()));
    const r = await releverAppartenance(db, 'notifuse', f);
    expect(r).toMatchObject({ etat: 'non_abouti', nonLus: ['prop@client.fr'], comptes: { jonction: 1 } });
    expect(r.raison).toContain('1 humain');
  });

  it.each([
    ['liste absente', new Response('', { status: 404 }), 'HTTP 404'],
    ['liste illisible', Response.json({ autre: [] }), 'illisible'],
  ])('%s : NON ABOUTI, jamais « aucun écart »', async (_n, reponse, raison) => {
    const r = await releverAppartenance(db, 'notifuse', app(reponse, () => espace()));
    expect(r).toMatchObject({ etat: 'non_abouti', humains: 0 });
    expect(r.raison).toContain(raison);
  });

  it('app non configurée ou injoignable : NON ABOUTI', async () => {
    expect((await releverAppartenance(db, 'notifuse', (async () => { throw new Error('réseau'); }) as never)).raison).toContain('injoignable');
    vi.stubEnv('NOTIFUSE_HUB_API_SECRET', '');
    expect((await releverAppartenance(db, 'notifuse')).raison).toContain('non configurée');
  });

  it('n\'écrit jamais', () => expect(ecriture).not.toHaveBeenCalled());
});
