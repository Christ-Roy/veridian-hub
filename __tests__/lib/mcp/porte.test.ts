/**
 * Porte MCP : trois outils exposés, catalogue fédéré relu chez l'app (le Hub ne code aucun outil
 * d'app), identité présentée en JWT ES256 vérifiable par la clé publique, accès par app, bornes.
 */
import { exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { viderCache } from '@/lib/mcp/catalogue';
import { SORTIE_MAX_CAR } from '@/lib/mcp/config';
import { jwksPublic } from '@/lib/mcp/identite';
import type { Appelant } from '@/lib/mcp/oauth';
import { borner, traiter } from '@/lib/mcp/porte';

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

type Recu = { auth: string; corps: any; session: string | null };

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
    recus.push({ auth: h.Authorization, corps, session: h['Mcp-Session-Id'] ?? null });
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
