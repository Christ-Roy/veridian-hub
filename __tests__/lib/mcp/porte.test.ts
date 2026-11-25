/**
 * Porte MCP : trois outils exposés, catalogue fédéré relu chez l'app (le Hub ne code aucun outil
 * d'app), identité présentée en JWT ES256 vérifiable par la clé publique, accès par app, bornes.
 */
import { exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { viderCache } from '@/lib/mcp/catalogue';
import { SORTIE_MAX_CAR } from '@/lib/mcp/config';
import { jwksPublic } from '@/lib/mcp/identite';
import type { Appelant } from '@/lib/mcp/oauth';
import { borner, traiter } from '@/lib/mcp/porte';
import { oublierProgrammes, type Moteur } from '@/lib/mcp/programme';

import { fausseBase, type FausseBase } from './fausse-base';

const HUB_USER = '11111111-2222-3333-4444-555555555555';
const QUI: Appelant = { hubUserId: HUB_USER, clientId: 'mcpc_test', scope: 'veridian', email: 'client@exemple.fr', name: 'Client', userId: 'u1' };
const URL_APP = 'https://analytics.exemple.test/api/mcp';

let ancienneCle: string | undefined;
beforeAll(async () => {
  ancienneCle = process.env.MCP_SIGNING_JWK;
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  process.env.MCP_SIGNING_JWK = JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'test-1' });
});
afterAll(() => {
  if (ancienneCle === undefined) delete process.env.MCP_SIGNING_JWK;
  else process.env.MCP_SIGNING_JWK = ancienneCle;
});

type Recu = { auth: string; corps: any; session: string | null; entetes: Record<string, string> };

/** App MCP factice : session à l'initialize, tools/list paginé en SSE, tools/call en JSON. */
function appFactice(opts: { outils?: any[]; sortie?: string; panne?: boolean; inconnu?: () => boolean; refusEspace?: string } = {}) {
  const recus: Recu[] = [];
  const outils = opts.outils ?? [
    { name: 'visites_du_site', description: 'Nombre de visites et visiteurs du site sur une période.', inputSchema: { type: 'object', properties: { jours: { type: 'number' } } }, annotations: { readOnlyHint: true } },
    { name: 'creer_objectif', description: 'Crée un objectif de conversion.', inputSchema: { type: 'object' } },
  ];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (opts.panne) throw new Error('ECONNREFUSED');
    const corps = JSON.parse(String(init.body));
    const h = init.headers as Record<string, string>;
    recus.push({ auth: h.Authorization, corps, session: h['Mcp-Session-Id'] ?? null, entetes: h });
    if (opts.inconnu?.()) return new Response(JSON.stringify({ error: 'hub_user_unknown' }), { status: 401 });
    if (opts.refusEspace && corps.method === 'initialize' && h.Authorization) {
      const charge = JSON.parse(Buffer.from(h.Authorization.split('.')[1], 'base64url').toString());
      if (charge.tenant_id) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32002, message: opts.refusEspace } }), { status: 403 });
    }
    if (corps.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: corps.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
    }
    if (!corps.id) return new Response(null, { status: 202 });
    if (corps.method === 'tools/list') {
      const page = corps.params?.cursor ? outils.slice(1) : outils.slice(0, 1);
      const result = { tools: page, ...(corps.params?.cursor ? {} : { nextCursor: 'p2' }) };
      const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: corps.id, result })}\n\n`;
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (corps.method === 'tools/call') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: corps.id, result: { content: [{ type: 'text', text: opts.sortie ?? `ok ${corps.params.name} ${JSON.stringify(corps.params.arguments)}` }] } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, recus };
}

let db: FausseBase;
beforeEach(async () => {
  viderCache();
  db = fausseBase();
  await db.mcpApp.create({ data: { appKey: 'analytics', label: 'Analytics', mcpUrl: URL_APP, acces: 'tenant_app' } });
  await db.tenantApp.create({ data: { userId: HUB_USER, appKey: 'analytics', enabled: true } });
  await db.tenant.create({ data: { id: 't1', userId: HUB_USER, name: 'Mon espace', slug: 'mon-espace', status: 'active', notifusePlan: 'free', prospectionPlan: 'freemium', createdAt: new Date() } });
});

const appel = (nom: string, args: Record<string, unknown>, f: ReturnType<typeof appFactice>) =>
  traiter(db as never, QUI, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: nom, arguments: args } }, { fetchImpl: f.fetchImpl });
const json = (r: any) => JSON.parse(r.result.content[0].text);

describe('plansDuHub : tous les plans tenus par le Hub', () => {
  it('Mail, Prospection, Analytics, CRM et Academy, depuis la seule source', async () => {
    const { plansDuHub } = await import('@/lib/mcp/porte');
    expect(
      plansDuHub({
        notifusePlan: 'free',
        prospectionPlan: 'pro',
        metadata: { analytics: {}, analytics_plan: 'pro', crm: { workspace_id: 'w' }, crm_plan: 'pro', academy: { workspace_id: 'a' }, academy_plan: 'internal' },
      }),
    ).toEqual({ mail: 'free', prospection: 'pro', analytics: 'pro', crm: 'pro', academy: 'internal' });
  });

  it('une app sans plan posé n\'invente rien', async () => {
    const { plansDuHub } = await import('@/lib/mcp/porte');
    expect(plansDuHub({ notifusePlan: 'free', prospectionPlan: null, metadata: { crm: { workspace_id: 'w' } } })).toEqual({ mail: 'free' });
  });
});

describe('protocole', () => {
  it('tools/list : exactement trois outils, quel que soit le nombre d\'apps', async () => {
    const r: any = await traiter(db as never, QUI, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['chercher_outils', 'decrire_outil', 'executer_outil']);
  });
  it('initialize : version négociée et consignes', async () => {
    const r: any = await traiter(db as never, QUI, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.instructions).toMatch(/chercher_outils/);
  });
  it('notification : aucune réponse ; méthode inconnue : -32601', async () => {
    expect(await traiter(db as never, QUI, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const r: any = await traiter(db as never, QUI, { jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(r.error.code).toBe(-32601);
  });
});

describe('catalogue fédéré', () => {
  it('chercher_outils trouve l\'outil de l\'app par le besoin, pages SSE comprises', async () => {
    const f = appFactice();
    const r = json(await appel('chercher_outils', { besoin: 'visites du site' }, f));
    expect(r.outils[0].nom).toBe('analytics.visites_du_site');
    expect(r.apps).toEqual(['hub', 'analytics']);
    // Deux pages relues chez l'app : le Hub ne connaît pas ses outils d'avance.
    const r2 = json(await appel('chercher_outils', { besoin: 'objectif conversion' }, f));
    expect(r2.outils[0].nom).toBe('analytics.creer_objectif');
  });
  it('une app non activée pour ce compte n\'est pas proposée', async () => {
    db.tenantApp.lignes[0].enabled = false;
    const r = json(await appel('chercher_outils', { besoin: 'visites' }, appFactice()));
    expect(r.apps).toEqual(['hub']);
    expect(r.outils).toEqual([]);
  });
  it('acces = tous : proposée sans activation', async () => {
    db.tenantApp.lignes.length = 0;
    db.mcpApp.lignes[0].acces = 'tous';
    const r = json(await appel('chercher_outils', { besoin: 'visites' }, appFactice()));
    expect(r.outils[0].nom).toBe('analytics.visites_du_site');
  });
  it('decrire_outil rend le schéma de l\'app', async () => {
    const r = json(await appel('decrire_outil', { nom: 'analytics.visites_du_site' }, appFactice()));
    expect(r.parametres.properties.jours.type).toBe('number');
    expect(r.annotations).toEqual({ readOnlyHint: true });
    expect(r.signature).toMatch(/^outil\("analytics\.visites_du_site", \{ .*jours\??: number.* \}\): Promise<unknown>$/);
    expect(r.signature).not.toContain('autoriser'); // lecture seule déclarée
  });
  it('chercher_outils porte la signature des meilleurs résultats seulement', async () => {
    const r = json(await appel('chercher_outils', { besoin: 'visites' }, appFactice()));
    expect(r.outils[0].signature).toContain('outil("analytics.visites_du_site"');
    expect(r.outils.filter((o: any) => o.signature).length).toBeLessThanOrEqual(3);
  });
  it('app en panne : signalée, sans casser les outils du Hub', async () => {
    const f = appFactice({ panne: true });
    const r = json(await appel('chercher_outils', { besoin: 'compte' }, f));
    expect(r.injoignables[0].app).toBe('analytics');
    expect(r.outils[0].nom).toBe('hub.mon_compte');
    const e: any = await appel('executer_outil', { nom: 'analytics.visites_du_site' }, f);
    expect(e.result.isError).toBe(true);
    expect(e.result.content[0].text).toMatch(/ne répond pas/);
  });
});

describe('exécution', () => {
  it('appelle l\'app avec un JWT ES256 vérifiable : aud = son URL MCP, sub = hub_user_id', async () => {
    const f = appFactice();
    const r: any = await appel('executer_outil', { nom: 'analytics.visites_du_site', arguments: { jours: 7 } }, f);
    expect(r.result.content[0].text).toBe('ok visites_du_site {"jours":7}');
    const dernier = f.recus.at(-1)!;
    expect(dernier.session).toBe('sess-1');
    const jeton = dernier.auth.replace('Bearer ', '');
    const { payload, protectedHeader } = await jwtVerify(jeton, createLocalJWKSet(await jwksPublic()), { issuer: 'https://app.veridian.site', audience: URL_APP });
    expect(protectedHeader.alg).toBe('ES256');
    expect(payload).toMatchObject({ sub: HUB_USER, email: 'client@exemple.fr', client_id: 'mcpc_test' });
    expect(payload.exp! - payload.iat!).toBe(300);
    // Une autre app ne peut pas rejouer ce jeton.
    await expect(jwtVerify(jeton, createLocalJWKSet(await jwksPublic()), { audience: 'https://crm.exemple.test/mcp' })).rejects.toThrow();
  });
  it('la clé publiée ne contient pas la partie privée', async () => {
    const { keys } = await jwksPublic();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('d');
  });
  it('journalise l\'appel sans les arguments', async () => {
    await appel('executer_outil', { nom: 'analytics.visites_du_site', arguments: { jours: 7, secret: 'x' } }, appFactice());
    const l = db.auditLog.lignes.at(-1)!;
    expect(l).toMatchObject({ action: 'mcp.tool.call', actor: 'oauth:mcpc_test', targetId: HUB_USER, payload: { outil: 'analytics.visites_du_site', ok: true } });
    expect(JSON.stringify(l.payload)).not.toContain('secret');
  });
  it('outil inconnu : erreur lisible, aucun appel à l\'app', async () => {
    const f = appFactice();
    const r: any = await appel('executer_outil', { nom: 'analytics.supprimer_tout' }, f);
    expect(r.result.isError).toBe(true);
    expect(f.recus.some((x) => x.corps.method === 'tools/call')).toBe(false);
  });
  it('hub.mon_compte : espaces du compte, apps connectées', async () => {
    const r = json(await appel('executer_outil', { nom: 'hub.mon_compte' }, appFactice()));
    expect(r.email).toBe('client@exemple.fr');
    expect(r.espaces[0]).toMatchObject({ slug: 'mon-espace', plans: { mail: 'free' } });
    expect(r.apps_connectees).toEqual([{ cle: 'analytics', nom: 'Analytics' }]);
  });
  it('sortie d\'app trop longue : tronquée avec avis', async () => {
    const r: any = await appel('executer_outil', { nom: 'analytics.visites_du_site' }, appFactice({ sortie: 'x'.repeat(SORTIE_MAX_CAR + 500) }));
    expect(r.result.content[0].text).toHaveLength(SORTIE_MAX_CAR);
    expect(r.result.content.at(-1).text).toMatch(/tronquée/);
  });
});

describe('borner', () => {
  it('laisse passer une sortie courte intacte', () => {
    const c = { content: [{ type: 'text' as const, text: 'court' }], structuredContent: { a: 1 } };
    expect(borner(c)).toEqual(c);
  });
});

describe('clé de signature', () => {
  it('lue en base64 (forme du job) comme en JSON', async () => {
    const { cleSignature } = await import('@/lib/mcp/identite');
    const json = process.env.MCP_SIGNING_JWK!;
    const env = { MCP_SIGNING_JWK: Buffer.from(json).toString('base64') } as NodeJS.ProcessEnv;
    expect((await cleSignature(env))?.kid).toBe('test-1');
  });
});

const claims = async (f: ReturnType<typeof appFactice>) => {
  const jeton = f.recus.at(-1)!.auth.replace('Bearer ', '');
  return (await jwtVerify(jeton, createLocalJWKSet(await jwksPublic()), { audience: URL_APP })).payload;
};

describe('espace (tenant_id signé)', () => {
  it('une app réservée cochée par une organisation s\'appelle par la porte, pour son membre vivant seulement', async () => {
    db.tenantApp.lignes.length = 0;
    (db as any).mcpApp.lignes[0].appKey = 'twenty';
    const lire = (db as any).tenant.findMany;
    (db as any).tenant.findMany = async (q: any) => (q.where.OR ? [{ id: 't1' }] : lire(q));
    (db as any).organisation = { findMany: async ({ where }: any) => (where.tenantId.in.includes('t1') ? [{ modules: ['crm'] }] : []) };
    const apps = async () => json(await appel('chercher_outils', { besoin: 'visites' }, appFactice())).apps;
    expect(await apps()).toContain('twenty');
    (db as any).organisation.findMany = async () => [{ modules: ['prospection'] }];
    expect(await apps()).not.toContain('twenty');
  });
  it('un seul espace, non choisi : rien n\'est signé (l\'app prend son espace par défaut)', async () => {
    const f = appFactice();
    await appel('executer_outil', { nom: 'analytics.visites_du_site' }, f);
    expect((await claims(f)).tenant_id).toBeUndefined();
  });
  it('un seul espace, choisi : signé', async () => {
    const f = appFactice();
    await appel('executer_outil', { nom: 'analytics.visites_du_site', espace: 'mon-espace' }, f);
    expect((await claims(f)).tenant_id).toBe('t1');
  });
  it('plusieurs espaces : celui choisi, membre compris ; sans choix, aucun', async () => {
    await db.tenant.create({ data: { id: 't2', userId: 'autre', name: 'Agence', slug: 'agence', status: 'active', createdAt: new Date() } });
    await db.tenantMember.create({ data: { tenantId: 't2', userId: HUB_USER, role: 'admin' } });
    const f = appFactice();
    await appel('executer_outil', { nom: 'analytics.visites_du_site', espace: 'agence' }, f);
    expect((await claims(f)).tenant_id).toBe('t2');
    await appel('executer_outil', { nom: 'analytics.visites_du_site' }, f);
    expect((await claims(f)).tenant_id).toBeUndefined();
    const r = json(await appel('executer_outil', { nom: 'hub.mon_compte' }, f));
    expect(r.espaces.map((e: any) => [e.slug, e.role])).toEqual([['mon-espace', 'proprietaire'], ['agence', 'admin']]);
  });
  it('journal : l\'espace choisi, ou le seul du compte ; plusieurs sans choix : aucun (jamais deviné)', async () => {
    const note = async (args: object) => { await appel('executer_outil', { nom: 'analytics.visites_du_site', ...args }, appFactice()); return (db.auditLog.lignes.at(-1)!.payload as any).espace; };
    expect(await note({})).toBe('t1');
    await db.tenant.create({ data: { id: 't2', userId: 'autre', name: 'Agence', slug: 'agence', status: 'active', createdAt: new Date() } });
    await db.tenantMember.create({ data: { tenantId: 't2', userId: HUB_USER, role: 'admin' } });
    expect([await note({}), await note({ espace: 'agence' }), await note({ espace: 'mon-espace' })]).toEqual([undefined, 't2', 't1']);
  });
  it('espace d\'un autre compte : refusé, rien n\'est signé', async () => {
    await db.tenant.create({ data: { id: 't3', userId: 'autre', name: 'Pas à moi', slug: 'pas-a-moi', status: 'active', createdAt: new Date() } });
    const f = appFactice();
    const r: any = await appel('executer_outil', { nom: 'analytics.visites_du_site', espace: 'pas-a-moi' }, f);
    expect(r.result.isError).toBe(true);
    expect(f.recus.some((x) => x.corps.method === 'tools/call')).toBe(false);
  });
});

describe('compte absent dans l\'app (hub_user_unknown)', () => {
  it('le Hub crée le compte par son provisionneur, puis l\'outil répond', async () => {
    let cree = false;
    const f = appFactice({ inconnu: () => !cree });
    const provisionneurs = { analytics: async () => ((cree = true), true) };
    const r = await traiter(db as never, QUI, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chercher_outils', arguments: { besoin: 'visites' } } }, { fetchImpl: f.fetchImpl, provisionneurs });
    expect(cree).toBe(true);
    expect(json(r).outils[0].nom).toBe('analytics.visites_du_site');
  });
  it('sans provisionneur : message clair, pas « injoignable »', async () => {
    const f = appFactice({ inconnu: () => true });
    const r = json(await traiter(db as never, QUI, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chercher_outils', arguments: { besoin: 'visites' } } }, { fetchImpl: f.fetchImpl, provisionneurs: {} }));
    expect(r.injoignables[0].raison).toMatch(/aucun compte Analytics/);
  });
  it('compte créé ailleurs (activation, rebond) : l\'échec mémorisé est oublié', async () => {
    const { oublierUtilisateur } = await import('@/lib/mcp/cache');
    let existe = false;
    const f = appFactice({ inconnu: () => !existe });
    const sans = { fetchImpl: f.fetchImpl, provisionneurs: {} };
    const cherche = () => traiter(db as never, QUI, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chercher_outils', arguments: { besoin: 'visites' } } }, sans);
    expect(json(await cherche()).injoignables).toHaveLength(1);
    existe = true;
    expect(json(await cherche()).injoignables, 'échec encore en cache').toHaveLength(1);
    oublierUtilisateur(HUB_USER, 'analytics');
    expect(json(await cherche()).outils[0].nom).toBe('analytics.visites_du_site');
  });
  it('l\'échec d\'un utilisateur ne bloque pas les autres', async () => {
    const f = appFactice({ inconnu: () => true });
    await traiter(db as never, QUI, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chercher_outils', arguments: { besoin: 'visites' } } }, { fetchImpl: f.fetchImpl, provisionneurs: {} });
    const AUTRE = { ...QUI, hubUserId: '99999999-2222-3333-4444-555555555555' };
    await db.tenantApp.create({ data: { userId: AUTRE.hubUserId, appKey: 'analytics', enabled: true } });
    const ok = appFactice();
    const r = json(await traiter(db as never, AUTRE, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chercher_outils', arguments: { besoin: 'visites' } } }, { fetchImpl: ok.fetchImpl }));
    expect(r.outils[0].nom).toBe('analytics.visites_du_site');
  });
});

describe('règle tenant_id du contrat (403 lisibles)', () => {
  it.each([
    ['tenant_not_linked', /pas relié dans l'app/],
    ['tenant_forbidden', /pas membre de cet espace/],
  ])('%s : rendu en clair à l\'IA, pas « refuse l\'identité »', async (code, attendu) => {
    const f = appFactice({ refusEspace: code });
    const r: any = await appel('executer_outil', { nom: 'analytics.visites_du_site', espace: 'mon-espace' }, f);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(attendu);
  });
});

describe('client_name dans le jeton présenté aux apps', () => {
  it('le nom du client IA part avec son identifiant (Atlas affiche « Claude connecté »)', async () => {
    const f = appFactice();
    await traiter(db as never, { ...QUI, clientName: 'Claude' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'executer_outil', arguments: { nom: 'analytics.visites_du_site' } } }, { fetchImpl: f.fetchImpl });
    expect(await claims(f)).toMatchObject({ client_id: 'mcpc_test', client_name: 'Claude' });
  });
});

describe('espace suspendu ou membre retiré (VER-245)', () => {
  const jouer = (args: Record<string, unknown>, f = appFactice()) => appel('executer_outil', { nom: 'analytics.visites_du_site', ...args }, f).then((r: any) => ({ r: r.result, appels: f.recus.filter((x) => x.corps.method === 'tools/call').length }));
  const suspendre = (id: string) => { (db.tenant as any).lignes.find((t: any) => t.id === id).status = 'suspended'; };

  it('seul espace suspendu : aucun outil d\'app, avec ou sans espace ; mon_compte le dit', async () => {
    suspendre('t1');
    for (const a of [{}, { espace: 'mon-espace' }, { espace: 't1' }]) {
      const { r, appels } = await jouer(a);
      expect([r.isError, appels], JSON.stringify(a)).toEqual([true, 0]);
      expect(r.content[0].text).toContain('suspendu');
    }
    const c = json(await appel('executer_outil', { nom: 'hub.mon_compte' }, appFactice()));
    expect(c).toMatchObject({ espaces: [], espaces_suspendus: [{ slug: 'mon-espace' }] });
  });

  it('un suspendu parmi d\'autres : on ne laisse pas l\'app prendre le sien par défaut, l\'autre reste ouvert', async () => {
    await db.tenant.create({ data: { id: 't9', userId: HUB_USER, name: 'Deux', slug: 'deux', status: 'active', createdAt: new Date() } });
    suspendre('t1');
    const sans = await jouer({});
    expect([sans.r.isError, sans.appels]).toEqual([true, 0]);
    expect(sans.r.content[0].text).toContain('deux');
    expect((await jouer({ espace: 'mon-espace' })).appels).toBe(0);
    expect((await jouer({ espace: 'deux' })).appels).toBe(1);
  });

  it('le rôle dans l\'organisation choisie est signé, jamais sans espace', async () => {
    await db.tenant.create({ data: { id: 't7', userId: 'autre', name: 'Sept', slug: 'sept', status: 'active', createdAt: new Date() } });
    await (db as any).tenantMember.create({ data: { tenantId: 't7', userId: HUB_USER, role: 'admin', deletedAt: null } });
    for (const [args, role] of [[{ espace: 'mon-espace' }, 'owner'], [{ espace: 'sept' }, 'admin'], [{}, undefined]] as const) {
      const f = appFactice();
      await appel('executer_outil', { nom: 'analytics.visites_du_site', ...args }, f);
      expect((await claims(f)).org_role, JSON.stringify(args)).toBe(role);
    }
  });

  it('membre retiré : l\'espace n\'est plus le sien, au prochain appel', async () => {
    await db.tenant.create({ data: { id: 't8', userId: 'autre', name: 'Agence', slug: 'agence8', status: 'active', createdAt: new Date() } });
    await (db as any).tenantMember.create({ data: { tenantId: 't8', userId: HUB_USER, role: 'member', deletedAt: null } });
    expect((await jouer({ espace: 'agence8' })).appels).toBe(1);
    (db as any).tenantMember.lignes.find((x: any) => x.tenantId === 't8').deletedAt = new Date();
    const apres = await jouer({ espace: 'agence8' });
    expect([apres.r.isError, apres.appels]).toEqual([true, 0]);
  });
});

describe('liaisons entre apps (VER-245 b.2)', () => {
  const inter = vi.hoisted(() => ({ lister: vi.fn(), regler: vi.fn() }));
  const abonner = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 'sans_objet'));
  vi.mock('@/lib/evenements/allumage', () => ({ suivreAbonnement: (...a: unknown[]) => abonner(...a) }));
  vi.mock('@/lib/delegation/interrupteur', () => ({ listerIntegrations: (...a: unknown[]) => inter.lister(...a), reglerIntegration: (...a: unknown[]) => inter.regler(...a) }));
  beforeEach(() => { inter.lister.mockReset().mockResolvedValue([{ paire: 'prospection>crm', etat: 'eteinte' }]); inter.regler.mockReset().mockResolvedValue({ etat: 'eteinte' }); });
  const regler = (args: Record<string, unknown> = {}) => appel('executer_outil', { nom: 'hub.integrations_regler', arguments: { paire: 'prospection>crm', etat: 'eteinte' }, ...args }, appFactice()) as Promise<any>;
  const autre = async (role: string) => {
    await db.tenant.create({ data: { id: 't6', userId: 'autre', name: 'Six', slug: 'six', status: 'active', createdAt: new Date() } });
    await (db as any).tenantMember.create({ data: { tenantId: 't6', userId: HUB_USER, role, deletedAt: null } });
  };

  it('l\'IA sait qu\'elles sont actives par défaut, et qu\'une coupure tient', async () => {
    const t = JSON.stringify(await appel('chercher_outils', { besoin: 'liaisons entre apps', app: 'hub' }, appFactice()));
    expect(t).toContain('Actives par défaut');
  });
  it('lister : le seul espace qu\'on a, ou celui qu\'on nomme ; jamais un espace étranger', async () => {
    expect(json(await appel('executer_outil', { nom: 'hub.integrations_lister' }, appFactice())).espace).toBe('mon-espace');
    await autre('member');
    expect(((await appel('executer_outil', { nom: 'hub.integrations_lister' }, appFactice())) as any).result.isError, 'deux espaces : préciser').toBe(true);
    expect(json(await appel('executer_outil', { nom: 'hub.integrations_lister', espace: 'six' }, appFactice())).espace).toBe('six');
    expect(((await appel('executer_outil', { nom: 'hub.integrations_lister', espace: 'pas-a-moi' }, appFactice())) as any).result.isError).toBe(true);
    expect(inter.lister.mock.calls.map((c) => c[1])).toEqual(['t1', 't6']);
  });
  it('régler : l\'espace, le compte et le client viennent de la porte, jamais des paramètres', async () => {
    await regler({ arguments: { paire: 'prospection>crm', etat: 'eteinte', tenantId: 'x', hubUserId: 'y', client: 'z' } });
    expect(inter.regler.mock.calls[0][1]).toMatchObject({ tenantId: 't1', hubUserId: HUB_USER, paire: 'prospection>crm', etat: 'eteinte' });
    expect(inter.regler.mock.calls[0][1].client).not.toBe('z');
    inter.regler.mockResolvedValue({ etat: 'a_confirmer', lien: 'https://l', expire_le: 'e' });
    expect(json(await regler({ arguments: { paire: 'prospection>crm', etat: 'allumee' } }))).toMatchObject({ etat: 'a_confirmer', lien: 'https://l' });
    inter.regler.mockResolvedValue({ refus: 'role_insuffisant' });
    expect((await regler()).result.isError).toBe(true);
    inter.regler.mockClear();
    expect((await regler({ arguments: { paire: 'p', etat: 'peut-être' } })).result.isError).toBe(true);
    expect(inter.regler).not.toHaveBeenCalled();
  });
  it('régler n\'est proposé qu\'à qui dirige un espace ; destructif, donc confirmé par le client', async () => {
    const trouve = async () => json(await appel('chercher_outils', { besoin: 'allumer une liaison entre deux apps' }, appFactice())).outils.map((o: any) => o.nom);
    expect(await trouve()).toEqual(expect.arrayContaining(['hub.integrations_regler', 'hub.integrations_lister']));
    expect(json(await appel('decrire_outil', { nom: 'hub.integrations_regler' }, appFactice())).annotations.destructiveHint).toBe(true);
    (db.tenant as any).lignes.find((x: any) => x.id === 't1').userId = 'autre';
    await autre('member');
    expect(await trouve()).not.toContain('hub.integrations_regler');
    expect((await regler()).result.isError).toBe(true);
    expect(inter.regler).not.toHaveBeenCalled();
  });
  it('un espace suspendu : ni lister ni régler', async () => {
    (db.tenant as any).lignes.find((x: any) => x.id === 't1').status = 'suspended';
    for (const nom of ['hub.integrations_lister', 'hub.integrations_regler']) expect(((await appel('executer_outil', { nom, arguments: { paire: 'p', etat: 'allumee' }, espace: 'mon-espace' }, appFactice())) as any).result.isError).toBe(true);
    expect([inter.lister.mock.calls, inter.regler.mock.calls]).toEqual([[], []]);
  });
});

describe('executer_programme', () => {
  /** Moteur factice : il demande des appels, attend leurs réponses, puis finit. L'exécuteur réel : programme.test.ts. */
  const moteur = (appels: { nom: string; args?: unknown }[]) => async (): Promise<Moteur> => {
    let ligne: (l: string) => void = () => {};
    let recues = 0;
    const fin = () => ligne(JSON.stringify({ t: 'fin', ok: true, valeur: { recues } }));
    return {
      surLigne: (f) => { ligne = f; },
      surFin: () => {},
      fermer: () => {},
      envoyer: (m) => {
        if (m.t === 'programme') setTimeout(() => { appels.forEach((a, i) => ligne(JSON.stringify({ t: 'appel', id: i + 1, ...a }))); if (!appels.length) fin(); }, 1);
        else if (++recues === appels.length) fin();
      },
    };
  };
  const prog = (args: Record<string, unknown>, appels: { nom: string; args?: unknown }[], f: ReturnType<typeof appFactice>, qui: Appelant = QUI) =>
    traiter(db as never, qui, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'executer_programme', arguments: args } }, { fetchImpl: f.fetchImpl, programme: true, ouvrirMoteur: moteur(appels) });
  const LIRE = { nom: 'analytics.visites_du_site', args: { jours: 7, secret: 'x' } };
  beforeEach(() => oublierProgrammes());

  it('outils qui administrent : jamais depuis un programme, même nommés ; un utilisateur ne se change pas non plus en direct', async () => {
    const f = appFactice({ outils: [
      { name: 'update_site_config', description: 'config', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      { name: 'add_member', description: 'membre', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      { name: 'creer_objectif', description: 'objectif', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    ] });
    const noms = ['analytics.update_site_config', 'analytics.add_member', 'analytics.creer_objectif'];
    await prog({ code: 'x', autoriser: noms }, noms.map((nom) => ({ nom })), f);
    const joues = () => f.recus.filter((x) => x.corps.method === 'tools/call').map((x) => x.corps.params.name);
    expect(joues(), 'le travail sur les données passe, nommé').toEqual(['creer_objectif']);
    const direct = (nom: string) => appel('executer_outil', { nom, arguments: {} }, f) as Promise<any>;
    const refus = await direct('analytics.add_member');
    expect([refus.result.isError, /qu'au Hub/.test(refus.result.content[0].text)]).toEqual([true, true]);
    expect((await direct('analytics.update_site_config')).result.isError ?? false, 'les réglages restent possibles en direct').toBe(false);
    expect(joues()).toEqual(['creer_objectif', 'update_site_config']);
  });
  it('un service extérieur ne se joue jamais depuis un programme, même nommé', async () => {
    vi.stubEnv('CONNECTEURS_OUVERTS', '1');
    const { cacheOutils } = await import('@/lib/mcp/cache');
    cacheOutils.set(`notion:${HUB_USER}`, { a: Date.now(), outils: [{ nom: 'notion.chercher', app: 'notion', local: 'chercher', description: '', inputSchema: {}, annotations: { readOnlyHint: true }, externe: 'Notion' }] });
    const lu: string[] = [];
    const avec = { ...db, tenant: { ...db.tenant, findMany: async () => [{ id: 't', name: 'E', slug: 'e', status: 'active' }] }, connexionExterne: { findMany: async () => [{ connecteur: 'notion' }], findUnique: async () => { lu.push('jeton'); return null; } } };
    const qui = { ...QUI, services: true };
    const direct: any = await traiter(avec as never, qui, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'executer_outil', arguments: { nom: 'notion.chercher' } } });
    expect([direct.result.content[0].text.endsWith('est à rebrancher : Connexions, dans votre espace Veridian.'), lu.length], 'témoin : en direct, son jeton est cherché').toEqual([true, 1]);
    const recu: string[] = [];
    const ouvrir = async () => { const x = await moteur([{ nom: 'notion.chercher' }])(); return { ...x, envoyer: (e: Record<string, unknown>) => { recu.push(JSON.stringify(e)); x.envoyer(e); } }; };
    await traiter(avec as never, qui, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'executer_programme', arguments: { code: 'x', autoriser: ['notion.chercher'] } } }, { programme: true, ouvrirMoteur: ouvrir });
    vi.unstubAllEnvs();
    expect([recu.some((x) => x.includes('service extérieur, en appel direct')), lu.length], 'refusé, et aucun jeton n\'a été cherché').toEqual([true, 1]);
  });
  it('offert seulement quand le moteur est configuré ; sinon trois outils et refus', async () => {
    const r: any = await traiter(db as never, QUI, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { programme: true, ouvrirMoteur: moteur([]) });
    expect(r.result.tools.map((t: any) => t.name)).toEqual(['chercher_outils', 'decrire_outil', 'executer_outil', 'executer_programme']);
    const n: any = await appel('executer_programme', { code: 'return 1' }, appFactice());
    expect(n.result).toMatchObject({ isError: true });
  });

  describe('hub.executer_programme : pour un client qui a gardé l\'ancienne liste', () => {
    const deps = (f: ReturnType<typeof appFactice>, appels: { nom: string; args?: unknown }[], plus: Record<string, unknown> = {}) => ({ fetchImpl: f.fetchImpl, programme: true, ouvrirMoteur: moteur(appels), ...plus });
    const outilPorte = (name: string, args: Record<string, unknown>, d: Record<string, unknown>) =>
      traiter(db as never, QUI, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, d as never) as Promise<any>;

    it.each(['traiter en masse', 'importer des milliers de prospects', 'boucle', 'déplacer 3000 contacts', 'traitement par lots'])('trouvé par « %s »', async (besoin) => {
      const r = json(await outilPorte('chercher_outils', { besoin }, deps(appFactice(), [])));
      expect(r.outils.map((o: any) => o.nom)).toContain('hub.executer_programme');
    });

    it('décrit en entier, et marqué destructif', async () => {
      const r = json(await outilPorte('decrire_outil', { nom: 'hub.executer_programme' }, deps(appFactice(), [])));
      expect(r.description).toContain('sauver(etat)');
      expect(r.parametres.required).toEqual(['code']);
      expect(r.signature).toContain('code: string');
      expect(r.signature).toContain('// à nommer dans autoriser');
      expect(r.annotations.destructiveHint).toBe(true);
    });

    it('joué par executer_outil : même chemin, même journal que le 4e outil', async () => {
      const f = appFactice();
      const r = json(await outilPorte('executer_outil', { nom: 'hub.executer_programme', arguments: { code: 'x' } }, deps(f, [LIRE, LIRE])));
      expect(r).toMatchObject({ etat: 'termine', resultat: { recues: 2 }, appels: { reussis: 2 } });
      expect(f.recus.filter((x) => x.corps.method === 'tools/call').every((x) => x.entetes['X-Veridian-MCP-Appel'] === 'programme')).toBe(true);
      expect(db.auditLog.lignes.filter((l: any) => l.action === 'mcp.programme')).toHaveLength(1);
    });

    it('l\'espace se dit à côté ou dedans ; un espace étranger, ou deux espaces, sont refusés', async () => {
      const f = appFactice();
      for (const a of [{ arguments: { code: 'x', espace: 'pas-a-moi' } }, { arguments: { code: 'x' }, espace: 'pas-a-moi' }, { arguments: { code: 'x', espace: 'un' }, espace: 'deux' }]) {
        const r = await outilPorte('executer_outil', { nom: 'hub.executer_programme', ...a }, deps(f, [LIRE]));
        expect(r.result.isError, JSON.stringify(a)).toBe(true);
      }
      expect(f.recus.filter((x) => x.corps.method === 'tools/call')).toHaveLength(0);
      // Deux espaces différents, dont un bon : ne pas deviner.
      const deux = await outilPorte('executer_outil', { nom: 'hub.executer_programme', arguments: { code: 'x', espace: 'mon-espace' }, espace: 'autre' }, deps(f, [LIRE]));
      expect(deux.result).toMatchObject({ isError: true });
      expect(deux.result.content[0].text).toContain('Deux espaces');
      expect(json(await outilPorte('executer_outil', { nom: 'hub.executer_programme', arguments: { code: 'x', espace: 'mon-espace' }, espace: 'mon-espace' }, deps(f, [LIRE])))).toMatchObject({ etat: 'termine' });
    });

    it('un programme n\'en lance pas un autre, par aucun nom, même autorisé', async () => {
      const noms = ['executer_programme', 'hub.executer_programme', 'executer_outil', 'hub.integrations_regler'];
      const r = json(await prog({ code: 'x', autoriser: noms }, noms.map((nom) => ({ nom, args: { code: 'y', nom: 'hub.executer_programme' } })), appFactice()));
      expect(r.appels).toMatchObject({ faits: 4, reussis: 0, echoues: 4 });
      expect(db.auditLog.lignes.filter((l: any) => l.action === 'mcp.programme')).toHaveLength(1);
      expect(db.auditLog.lignes.filter((l: any) => l.action === 'mcp.tool.call'), 'refusé avant d\'être joué').toHaveLength(0);
    });

    it('un résultat long n\'est pas recoupé par la borne des outils : la réponse reste un JSON entier', async () => {
      const long = async (): Promise<Moteur> => {
        let ligne: (l: string) => void = () => {};
        return { surLigne: (f) => { ligne = f; }, surFin: () => {}, fermer: () => {}, envoyer: (m) => { if (m.t === 'programme') setTimeout(() => ligne(JSON.stringify({ t: 'fin', ok: true, valeur: 'x'.repeat(40_000) })), 1); } };
      };
      const r = json(await outilPorte('executer_outil', { nom: 'hub.executer_programme', arguments: { code: 'x' } }, deps(appFactice(), [], { ouvrirMoteur: long })));
      expect(r).toMatchObject({ etat: 'termine', resultat_tronque: true });
    });

    it('fermé par défaut (Mon IA) : ni trouvé, ni décrit, ni joué, par aucun nom, même moteur présent', async () => {
      const f = appFactice();
      const ouvrir = vi.fn(moteur([LIRE]));
      const d = { fetchImpl: f.fetchImpl, ouvrirMoteur: ouvrir };
      expect(JSON.stringify(json(await outilPorte('chercher_outils', { besoin: 'traiter en masse boucle programme' }, d)))).not.toContain('executer_programme');
      for (const [n, a] of [['decrire_outil', { nom: 'hub.executer_programme' }], ['executer_outil', { nom: 'hub.executer_programme', arguments: { code: 'x' } }], ['executer_programme', { code: 'x' }]] as const) {
        expect((await outilPorte(n, a, d)).result.isError, n).toBe(true);
      }
      expect(((await traiter(db as never, QUI, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, d as never)) as any).result.tools).toHaveLength(3);
      expect(ouvrir).not.toHaveBeenCalled();
    });
  });

  it('un programme ne s\'ouvre pas sur un espace suspendu, ni quand l\'app prendrait le suspendu par défaut', async () => {
    (db.tenant as any).lignes.find((t: any) => t.id === 't1').status = 'suspended';
    const f = appFactice();
    for (const a of [{}, { espace: 'mon-espace' }]) {
      const r = (await prog({ code: 'x', ...a }, [LIRE], f)) as any;
      expect([r.result.isError, r.result.content[0].text.includes('suspendu')], JSON.stringify(a)).toEqual([true, true]);
    }
    expect(f.recus.filter((x) => x.corps.method === 'tools/call')).toHaveLength(0);
  });

  it('cinquante appels : une seule session chez l\'app, l\'en-tête annoncé, la même identité', async () => {
    const f = appFactice();
    const r = json(await prog({ code: 'x' }, Array.from({ length: 50 }, () => LIRE), f));
    expect(r).toMatchObject({ etat: 'termine', resultat: { recues: 50 }, appels: { faits: 50, reussis: 50 } });
    const desAppels = f.recus.filter((x) => x.corps.method === 'tools/call');
    expect(desAppels).toHaveLength(50);
    expect(new Set(desAppels.map((x) => x.auth)).size).toBe(1);
    expect(desAppels.every((x) => x.entetes['X-Veridian-MCP-Appel'] === 'programme')).toBe(true);
    expect(await claims(f)).toMatchObject({ sub: HUB_USER, email: 'client@exemple.fr', client_id: 'mcpc_test' });
  });

  it('un appel ordinaire n\'annonce pas le mode programme', async () => {
    const f = appFactice();
    await appel('executer_outil', { nom: 'analytics.visites_du_site' }, f);
    expect(f.recus.some((x) => 'X-Veridian-MCP-Appel' in x.entetes)).toBe(false);
  });

  it('inter-espaces : tous les appels dans l\'espace choisi, quoi que mette le programme dans ses arguments', async () => {
    await db.tenant.create({ data: { id: 't2', userId: 'autre', name: 'Agence', slug: 'agence', status: 'active', createdAt: new Date() } });
    await db.tenantMember.create({ data: { tenantId: 't2', userId: HUB_USER, role: 'admin' } });
    const f = appFactice();
    await prog({ code: 'x', espace: 'mon-espace' }, [{ ...LIRE, espace: 'agence', tenantId: 't2' } as never, { nom: LIRE.nom, args: { espace: 'agence', tenant_id: 't2' } }], f);
    const signes = new Set(f.recus.filter((x) => x.corps.method === 'tools/call').map((x) => JSON.parse(Buffer.from(x.auth.split('.')[1], 'base64url').toString()).tenant_id));
    expect(Array.from(signes)).toEqual(['t1']);
  });

  it('espace d\'un autre compte : refusé, le moteur n\'est pas ouvert', async () => {
    await db.tenant.create({ data: { id: 't3', userId: 'autre', name: 'Pas à moi', slug: 'pas-a-moi', status: 'active', createdAt: new Date() } });
    const f = appFactice();
    const r: any = await prog({ code: 'x', espace: 'pas-a-moi' }, [LIRE], f);
    expect(r.result.isError).toBe(true);
    expect(f.recus.some((x) => x.corps.method === 'tools/call')).toBe(false);
  });

  it('journal : chaque appel avec l\'identifiant du programme, un bilan, jamais le code ni les arguments', async () => {
    const r = json(await prog({ code: 'const SECRET_DU_CODE = 1', autoriser: ['analytics.creer_objectif'] }, [LIRE, { nom: 'analytics.creer_objectif', args: { nom: 'CONFIDENTIEL' } }], appFactice()));
    const l = db.auditLog.lignes as any[];
    expect(l.filter((x) => x.action === 'mcp.tool.call').map((x) => [x.payload.outil, x.payload.programme])).toEqual(expect.arrayContaining([['analytics.visites_du_site', r.programme], ['analytics.creer_objectif', r.programme]]));
    expect(l.find((x) => x.action === 'mcp.programme').payload).toMatchObject({ programme: r.programme, etat: 'termine', appels: 2, echecs: 0, autoriser: ['analytics.creer_objectif'] });
    expect(JSON.stringify(l)).not.toMatch(/SECRET_DU_CODE|CONFIDENTIEL|secret/);
  });

  it('sans annotation et non nommé : refusé, l\'app n\'est pas appelée', async () => {
    const f = appFactice();
    expect(json(await prog({ code: 'x' }, [{ nom: 'analytics.creer_objectif' }], f)).appels).toMatchObject({ faits: 1, echoues: 1 });
    expect(f.recus.some((x) => x.corps.method === 'tools/call')).toBe(false);
  });

  it('une app non ouverte à ce compte reste fermée au programme', async () => {
    db.tenantApp.lignes[0].enabled = false;
    const f = appFactice();
    expect(json(await prog({ code: 'x' }, [LIRE], f)).appels.echoues).toBe(1);
    expect(f.recus).toHaveLength(0);
  });

  it.each([
    ['code absent', {}], ['code vide', { code: '  ' }], ['code trop long', { code: 'x'.repeat(100_001) }],
    ['autoriser mal formé', { code: 'x', autoriser: 'tout' }], ['autoriser trop long', { code: 'x', autoriser: Array(51).fill('a.b') }], ['reprise trop longue', { code: 'x', reprise: 'y'.repeat(3_000) }],
  ])('%s : refusé avant de lancer', async (_n, args) => {
    const r: any = await prog(args, [LIRE], appFactice());
    expect(r.result.isError).toBe(true);
  });

  it('la place se libère, même après un échec ; deux comptes ne se gênent pas', async () => {
    const f = appFactice();
    for (let i = 0; i < 3; i++) expect(json(await prog({ code: 'x' }, [LIRE], f)).etat).toBe('termine');
    const [a, b] = await Promise.all([prog({ code: 'x' }, [LIRE], f), prog({ code: 'x' }, [LIRE], f)]);
    expect([a, b].filter((r: any) => r.result.isError)).toHaveLength(1);
  });

  it('réponse d\'app de plus de 1 Mo : erreur dite au programme, jamais une donnée coupée', async () => {
    const r = json(await prog({ code: 'x' }, [LIRE], appFactice({ sortie: 'x'.repeat(1_100_000) })));
    expect(r.appels).toMatchObject({ reussis: 0, echoues: 1 });
  });

  it('réponse de 500 000 caractères : entière pour le programme (16 000 seulement pour un appel direct)', async () => {
    expect(json(await prog({ code: 'x' }, [LIRE], appFactice({ sortie: 'x'.repeat(500_000) }))).appels.reussis).toBe(1);
    const d: any = await appel('executer_outil', { nom: 'analytics.visites_du_site' }, appFactice({ sortie: 'x'.repeat(500_000) }));
    expect(d.result.content[0].text.length).toBeLessThanOrEqual(SORTIE_MAX_CAR);
  });
});
