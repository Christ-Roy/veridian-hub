// @vitest-environment node
/** Échange d'une poignée : chaque vérification, vue refuser, et le jeton tel que la cible le lit. */
import { createHmac } from 'node:crypto';

import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { echanger, FENETRE_MS, oublierDebit, TTL_ACTION_S, verifierAppel } from '@/lib/delegation/jeton';
import { empreintePortees, paire } from '@/lib/delegation/paires';
import { emettrePoignees } from '@/lib/delegation/poignee';
import { jwksPublic } from '@/lib/mcp/identite';

import { base } from './fausse';

let ENV: NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
let grant: string;
const PAIRE = paire('prospection>crm')!;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  ENV = { NODE_ENV: 'test', DELEGATION_CIBLES: 'crm', MCP_SIGNING_JWK: JSON.stringify({ ...(await exportJWK(privateKey)), kid: 'k1' }) };
});
beforeEach(async () => {
  oublierDebit();
  db = base();
  db.tenant.lignes.push({ id: 'A', userId: 'p', status: 'active' });
  db.tenantMember.lignes.push({ tenantId: 'A', userId: 'u', role: 'member' });
  db.user.lignes.push({ supabaseUserId: 'u', email: 'u@x.fr', emailVerified: new Date() });
  db.mcpApp.lignes.push({ appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true });
  db.integrationPaire.lignes.push({ tenantId: 'A', paire: PAIRE.cle, etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(PAIRE) });
  grant = (await emettrePoignees(db as never, { hubUserId: 'u', app: 'prospection' }, ENV))[0].grant;
});
const demander = (o: object = {}, app = 'prospection') => echanger(db as never, app as never, { subject_grant: grant, audience: 'crm', scope: 'crm:societe.ecrire crm:tache.ecrire', ...o }, ENV);

describe('verifierAppel', () => {
  const entetes = (corps: string, o: { secret?: string; ts?: number; nonce?: string; app?: string } = {}) => {
    const ts = String(o.ts ?? Date.now());
    const nonce = o.nonce ?? 'nonce-0123456789abcdef';
    return new Headers({ 'x-veridian-app': o.app ?? 'prospection', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': createHmac('sha256', o.secret ?? 's-prosp').update(`${ts}.${nonce}.${corps}`).digest('hex') });
  };
  beforeEach(() => { vi.stubEnv('PROSPECTION_HUB_API_SECRET', 's-prosp'); vi.stubEnv('CRM_HUB_API_SECRET', 's-crm'); });
  const v = (h: Headers, corps = '{}') => verifierAppel(db as never, h, corps);

  it('la bonne signature passe, une fois : le même nonce est refusé', async () => {
    expect(await v(entetes('{}'))).toEqual({ app: 'prospection' });
    expect(await v(entetes('{}'))).toEqual({ statut: 401, error: 'nonce_replayed' });
    expect(await v(entetes('{}', { nonce: 'un-autre-nonce-0123456' }))).toEqual({ app: 'prospection' });
  });
  it('corps changé, secret d\'une autre app, autre app annoncée, horloge, en-têtes : refusé, aucun nonce consommé', async () => {
    const refus = [await v(entetes('{}'), '{"x":1}'), await v(entetes('{}', { secret: 's-crm' })), await v(entetes('{}', { app: 'crm' })), await v(entetes('{}', { ts: Date.now() - FENETRE_MS - 1000 })), await v(entetes('{}', { ts: Date.now() + FENETRE_MS + 1000 })), await v(entetes('{}', { nonce: 'court' })), await v(entetes('{}', { app: 'cms' })), await v(new Headers())];
    expect(refus.map((r) => ('statut' in r ? r.statut : 'PASSE'))).toEqual([401, 401, 401, 401, 401, 400, 400, 400]);
    expect(db.delegationNonce.lignes).toEqual([]);
  });
  it('app sans secret : 503, jamais ouverte', async () => {
    vi.stubEnv('PROSPECTION_HUB_API_SECRET', '');
    vi.stubEnv('PROSPECTION_TENANT_API_SECRET', '');
    expect(await v(entetes('{}', { secret: '' }))).toEqual({ statut: 503, error: 'app_not_configured' });
  });
});

describe('echanger', () => {
  it('le jeton que lit la cible : qui agit, pour qui, où, 120 s, portées étroites', async () => {
    const r = await demander({ motif: 'bouton' });
    if ('error' in r) throw new Error(r.error);
    const { payload } = await jwtVerify(r.jeton, createLocalJWKSet((await jwksPublic(ENV)) as { keys: JWK[] }), { audience: 'https://crm.test/mcp' });
    expect(payload).toMatchObject({ sub: 'u', tenant_id: 'A', act: { sub: 'app:prospection' }, scope: 'crm:societe.ecrire crm:tache.ecrire', email: 'u@x.fr' });
    expect(payload.act).toEqual({ sub: 'app:prospection' });
    expect([payload.exp! - payload.iat!, TTL_ACTION_S, typeof payload.jti]).toEqual([120, 120, 'string']);
    expect(JSON.stringify(payload)).not.toContain('veridian ');
    const a = db.auditLog.lignes[0];
    expect(a).toMatchObject({ action: 'delegation.jeton', targetId: 'A', payload: { paire: 'prospection>crm', jti: payload.jti, motif: 'bouton' } });
    expect(JSON.stringify(a)).not.toContain(grant);
    expect(db.integrationPaire.lignes[0].dernierPassage).toBeInstanceOf(Date);
  });
  it('deux échanges : deux jti', async () => {
    const [a, b] = [await demander(), await demander()];
    expect('jeton' in a && 'jeton' in b && a.jeton !== b.jeton).toBe(true);
  });

  const casse: [string, string, () => void | Promise<void>, object?, string?][] = [
    ['paire absente', 'pair_not_allowed', () => {}, { audience: 'notifuse' }, 'notifuse'],
    ['portée hors paire', 'pair_not_allowed', () => {}, { scope: 'crm:societe.supprimer' }],
    ['portée complète', 'pair_not_allowed', () => {}, { scope: 'veridian' }],
    ['cible non servie', 'target_not_served', () => {}, { audience: 'notifuse', scope: 'notifuse:contacts.ecrire' }],
    ['poignée d\'une autre app', 'grant_invalid', () => {}, { scope: 'crm:tache.ecrire' }, 'notifuse'],
    ['poignée inventée', 'grant_invalid', () => {}, { subject_grant: 'x'.repeat(43) }],
    ['poignée révoquée', 'grant_invalid', () => { db.delegationGrant.lignes[0].revoqueLe = new Date(); }],
    ['poignée expirée', 'grant_invalid', () => { db.delegationGrant.lignes[0].expireLe = new Date(Date.now() - 1); }],
    ['membre retiré', 'not_member', () => { db.tenantMember.lignes[0].deletedAt = new Date(); }],
    ['jamais membre', 'not_member', () => { db.tenantMember.lignes.length = 0; }],
    ['adresse plus prouvée', 'user_invalid', () => { db.user.lignes[0].emailVerified = null; }],
    ['compte supprimé', 'user_invalid', () => { db.user.lignes.length = 0; }],
    ['tenant suspendu', 'tenant_suspended', () => { db.tenant.lignes[0].status = 'suspended'; }],
    ['tenant supprimé', 'tenant_not_found', () => { db.tenant.lignes[0].deletedAt = new Date(); }],
    ['liaison éteinte', 'integration_off', () => { db.integrationPaire.lignes[0].etat = 'eteinte'; }],
    ['liaison jamais allumée', 'integration_off', () => { db.integrationPaire.lignes.length = 0; }],
    ['sans consentement', 'integration_off', () => { db.integrationPaire.lignes[0].consentiLe = null; }],
    ['portée élargie depuis le consentement', 'integration_off', () => { db.integrationPaire.lignes[0].portees = 'ancienne'; }],
  ];
  it.each(casse)('%s : %s', async (_n, error, casser, o, app) => {
    await casser();
    expect(await demander(o, app)).toMatchObject({ statut: 403, error });
    expect(db.auditLog.lignes.filter((x) => x.action === 'delegation.jeton')).toEqual([]);
  });
  it('cible absente du registre MCP : 503', async () => {
    db.mcpApp.lignes[0].enabled = false;
    expect(await demander()).toEqual({ statut: 503, error: 'target_not_registered' });
  });
  it('débit par app et organisation : 429 au-delà, l\'organisation voisine n\'est pas touchée', async () => {
    for (let i = 0; i < 60; i++) expect('jeton' in (await demander())).toBe(true);
    expect(await demander()).toEqual({ statut: 429, error: 'rate_limited' });
    db.tenant.lignes.push({ id: 'B', userId: 'u', status: 'active' });
    db.integrationPaire.lignes.push({ ...db.integrationPaire.lignes[0], tenantId: 'B' });
    const b = (await emettrePoignees(db as never, { hubUserId: 'u', app: 'prospection' }, ENV)).find((x) => x.hub_tenant_id === 'B')!;
    expect('jeton' in (await demander({ subject_grant: b.grant }))).toBe(true);
  });
});
