// @vitest-environment node
/** L'état d'une app est celui qu'elle rend ; ce qui n'ouvrirait pas le dit (VER-263). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ discover: vi.fn(), gated: vi.fn(), mail: vi.fn() }));
vi.mock('@/lib/sync/discovery', () => ({ discoverAppForEmail: m.discover, readAppUrl: () => 'https://x', readAppSecret: (a: string) => (a === 'prospection' ? null : 's') }));
vi.mock('@/lib/tenant-apps', () => ({ getEnabledGatedApps: m.gated }));
vi.mock('@/lib/apps/presence', async (o) => ({ ...(await o<typeof import('@/lib/apps/presence')>()), espaceMailVivant: m.mail }));
vi.mock('@/lib/mcp/catalogue', () => ({ tousEspaces: async () => ({ vivants: [{ id: 'T1', nom: 'brut', slug: 's', role: 'proprietaire' }], suspendus: [{ id: 'T2', nom: 'Deux', slug: 'd', role: 'member' }] }) }));

import { chercherClients, entreeDe, ficheClient } from '@/lib/emprunt/entrees';

const snap = (o = {}) => ({ app: 'crm', workspaceId: 'w1', status: 'active', observedAt: '', ...o });
const db = (prouvee = true) => ({
  user: { findFirst: async () => ({ email: 'c@c', name: null, emailVerified: prouvee ? new Date() : null }) },
  tenant: { findMany: async () => [{ id: 'T1', name: 'brut', notifuseWorkspaceSlug: 'm1', prospectionProvisionedAt: null, metadata: { crm: { workspace_id: 'w1' } } }] },
  organisation: { findMany: async () => [{ tenantId: 'T1', nomAffiche: 'Beau nom' }] },
}) as never;
const app = async (a: string, d = db()) => (await ficheClient(d, 'H'))!.apps.find((x) => x.app === a)!;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(process.env, { CRM_API_URL: 'https://crm', NOTIFUSE_API_URL: 'https://mail/', ANALYTICS_API_URL: 'https://ana/', ACADEMY_API_URL: 'https://aca', NEXT_PUBLIC_PROSPECTION_URL: 'https://pro' });
  m.discover.mockResolvedValue({ found: true, snapshots: [snap()] });
  m.gated.mockResolvedValue(new Set(['academy']));
  m.mail.mockResolvedValue(true);
});

describe('ficheClient', () => {
  it('ouverte : l\'espace et l\'organisation qui le porte, nom choisi', async () => expect(await app('crm')).toMatchObject({ etat: 'ouverte', entrable: true, detail: '', espaces: [{ nom: 'w1', organisation: 'Beau nom' }] }));
  it('les organisations, la suspendue marquée', async () => expect((await ficheClient(db(), 'H'))!.organisations).toEqual([{ id: 'T1', nom: 'Beau nom', role: 'proprietaire', suspendue: false }, { id: 'T2', nom: 'Deux', role: 'member', suspendue: true }]));
  it.each([
    [{ error: 'timeout' }, 'illisible'],
    [{ found: false }, 'inconnu'],
    [{ found: true, snapshots: [] }, 'compte_sans_espace'],
    [{ found: true, snapshots: [snap({ status: 'deleted' })] }, 'compte_sans_espace'],
    [{ found: true, snapshots: [snap({ status: 'suspended' })] }, 'suspendue'],
  ])('%j : %s, pas d\'entrée, une raison', async (r, etat) => {
    m.discover.mockResolvedValue(r);
    const a = await app('crm');
    expect([a.etat, a.entrable, a.detail.length > 0]).toEqual([etat, false, true]);
  });
  it('Mail : espace supprimé chez lui = plus d\'espace ; état illisible = illisible', async () => {
    m.mail.mockResolvedValue(false);
    expect((await app('notifuse')).etat).toBe('compte_sans_espace');
    m.mail.mockResolvedValue(null);
    expect((await app('notifuse')).etat).toBe('illisible');
  });
  it('Academy non activée : elle n\'est même pas interrogée', async () => {
    m.gated.mockResolvedValue(new Set());
    expect((await app('academy')).etat).toBe('non_activee');
  });
  it('app sans secret : non branchée', async () => expect((await app('prospection')).etat).toBe('non_branchee'));
  it('adresse jamais prouvée : ouvrable, mais c\'est dit', async () => expect((await app('crm', db(false))).detail).toContain('jamais prouvée'));
  it('compte inconnu : null', async () => expect(await ficheClient({ user: { findFirst: async () => null } } as never, 'H')).toBeNull());
});

it('entreeDe : le rebond signé, Analytics comprise ; null si non branchée', () => {
  expect([entreeDe('hub'), entreeDe('analytics', { ANALYTICS_API_URL: 'https://ana/' } as never), entreeDe('crm', {} as never), entreeDe('analytics', {} as never)]).toEqual(['/dashboard', '/login?next=https%3A%2F%2Fana%2F', null, null]);
});

it('chercherClients : un texte trop court ne lit rien', async () => expect(await chercherClients({} as never, ' a ')).toEqual({ trouves: [], tronque: false }));
