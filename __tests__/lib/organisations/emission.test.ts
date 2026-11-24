// @vitest-environment node
import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emettreOrganisation, suivreOrganisation } from '@/lib/organisations/emission';

import { base } from './fausse';

const ENV = { NODE_ENV: 'test', ACADEMY_API_URL: 'https://a.test', ACADEMY_HUB_API_SECRET: 's', AUTH_URL: 'https://hub.test' } as NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
beforeEach(() => {
  db = base();
  db.tenant.lignes.push({ id: 'A', userId: 'p', name: 'Atelier', status: 'active', createdAt: new Date('2026-01-01') });
  db.user.lignes.push({ supabaseUserId: 'p', email: 'p@x.fr', name: null, emailVerified: new Date() });
  db.organisation.lignes.push({ tenantId: 'A', type: 'individuel', modules: ['academy'], reglages: {}, version: BigInt(0), empreinte: null, nomAffiche: null, couleurPrimaire: null, couleurAccent: null, logoEmpreinte: null });
});
function app(o: { post?: () => Response; version?: (recue: number) => unknown } = {}) {
  const posts: any[] = [];
  const f = (async (u: string, i: RequestInit) => {
    const h = i.headers as Record<string, string>;
    const corps = i.method === 'POST' ? String(i.body) : '';
    expect(h['X-Veridian-Hub-Signature']).toBe(createHmac('sha256', 's').update(`${h['X-Veridian-Timestamp']}.${corps}`).digest('hex'));
    if (i.method === 'POST') { posts.push({ u, corps: JSON.parse(corps) }); return o.post?.() ?? Response.json({ applied: true }); }
    const v = (o.version ?? ((x) => x))(posts.at(-1).corps.version);
    return v === 404 ? new Response('', { status: 404 }) : Response.json({ version: v });
  }) as unknown as typeof fetch;
  return { f, posts };
}
const emettre = async (a: ReturnType<typeof app>) => (await emettreOrganisation(db as never, 'A', { env: ENV, fetchImpl: a.f }))[0];

describe('emettreOrganisation', () => {
  it('signé, vers l\'app cochée, relu, noté', async () => {
    const a = app();
    expect(await emettre(a)).toMatchObject({ app: 'academy', etat: 'applique' });
    expect(a.posts[0]).toMatchObject({ u: 'https://a.test/api/hub/organisations/sync', corps: { hub_tenant_id: 'A', nom: 'Atelier' } });
    expect(db.organisationEmission.lignes).toEqual([expect.objectContaining({ tenantId: 'A', app: 'academy', etat: 'applique' })]);
  });
  it.each([
    ['l\'app dit oui et sert une autre version', app({ version: () => 1 }), 'echec'],
    ['pas de route de relecture', app({ version: () => 404 }), 'non_relu'],
    ['déjà à jour, relu', app({ post: () => Response.json({ applied: false, reason: 'unchanged' }) }), 'applique'],
    ['version ancienne', app({ post: () => Response.json({ applied: false, reason: 'stale' }) }), 'ignore'],
    ['route absente', app({ post: () => new Response('', { status: 404 }) }), 'echec'],
    ['200 illisible', app({ post: () => new Response('ok') }), 'echec'],
  ])('%s', async (_n, a, etat) => expect((await emettre(a)).etat).toBe(etat));
  it('app non cochée, ou organisation non réglée : rien n\'est envoyé', async () => {
    db.organisation.lignes[0].modules = [];
    const a = app();
    expect(await emettreOrganisation(db as never, 'A', { env: ENV, fetchImpl: a.f })).toEqual([]);
    db.organisation.lignes.length = 0;
    expect(await emettreOrganisation(db as never, 'A', { env: ENV, fetchImpl: a.f })).toEqual([]);
    expect(a.posts).toEqual([]);
  });
});
it('suivreOrganisation : une base en panne ne fait pas échouer le changement de membre', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await suivreOrganisation({ organisation: { findUnique: async () => { throw new Error('base'); } } } as never, 'A')).toEqual([]);
  vi.restoreAllMocks();
});
