/** Visites par lots (CONTRAT-HUB §5.26) : signature et nonce de l'app, forme stricte, organisation neuve ou consentie, plafond, idempotence, relais compté. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEUVE_DEPUIS } from '@/lib/delegation/etat';
import { oublierDebit } from '@/lib/delegation/jeton';
import { empreintePortees, paire } from '@/lib/delegation/paires';
import { cleDeVisite, recevoirVisites, trierVisite, VISITES_MAX_LOT } from '@/lib/evenements/visite';

import { base, cleDeTest, table } from './fausse';

const SECRET = 'secret-analytics-de-test-32-octets-min';
const NOW = 1_800_000_000_000;
const CONTACT = 'Client@Exemple.fr';
let env: NodeJS.ProcessEnv;
let db: ReturnType<typeof base> & { delegationNonce: ReturnType<typeof table> };
let crm: ReturnType<typeof vi.fn>;
let tenant: string;
let avantSecret: string | undefined;

const ANCIENNE = new Date('2025-06-01T00:00:00Z');
const NEUVE = new Date(NEUVE_DEPUIS.getTime() + 86_400_000);

beforeAll(async () => {
  avantSecret = process.env.ANALYTICS_HUB_API_SECRET;
  process.env.ANALYTICS_HUB_API_SECRET = SECRET;
  env = { ...(await cleDeTest()), DELEGATION_EVENEMENTS: 'analytics>crm#visite' };
});
afterAll(() => {
  if (avantSecret === undefined) delete process.env.ANALYTICS_HUB_API_SECRET;
  else process.env.ANALYTICS_HUB_API_SECRET = avantSecret;
});

const crmOk = (lignes = { creees: 1, avancees: 0, ignorees: 0 }, ignorees: unknown[] = []) =>
  vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, lignes, ignorees }) }] } }), { headers: { 'content-type': 'application/json' } }));

/** Une base avec une organisation : neuve (allumée d'office) ou ancienne, et le CRM ouvert. */
async function monter(o: { neuve?: boolean; ligne?: Record<string, unknown> | null } = {}) {
  tenant = randomUUID();
  db = { ...base(), delegationNonce: table([['empreinte']]) } as never;
  crm = crmOk();
  await db.tenant.create({ data: { id: tenant, userId: 'u', status: 'active', deletedAt: null, createdAt: o.neuve === false ? ANCIENNE : NEUVE, metadata: { crm: { workspace_id: 'c1' }, analytics: { workspace_id: 'a1' } } } });
  await db.mcpApp.create({ data: { appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true } });
  if (o.ligne) await db.integrationPaire.create({ data: { tenantId: tenant, paire: 'analytics>crm#visite', ...(o.ligne ?? {}) } });
}

const visite = (o: Record<string, unknown> = {}) => ({ session_id: 'sess-0001-abcd', contact_email: CONTACT, debut: new Date(NOW - 120_000).toISOString(), fin: new Date(NOW - 60_000).toISOString(), duree_s: 60, pages_vues: 2, chemins: ['/tarifs', '/contact?jeton=abc#x'], ...o });
const lot = (visites: unknown[] = [visite()], o: Record<string, unknown> = {}) => ({ hub_tenant_id: tenant, lot_id: randomUUID(), visites, ...o });

/** Une requête signée par Analytics : HMAC du secret sur `ts.nonce.corps`, comme `verifierAppel` le relit. */
function signer(corps: string, o: { secret?: string; nonce?: string; ts?: number; app?: string } = {}) {
  const ts = String(o.ts ?? NOW);
  const nonce = o.nonce ?? randomBytes(16).toString('base64url');
  const sig = createHmac('sha256', o.secret ?? SECRET).update(`${ts}.${nonce}.${corps}`).digest('hex');
  return new Headers({ 'x-veridian-app': o.app ?? 'analytics', 'x-veridian-timestamp': ts, 'x-veridian-nonce': nonce, 'x-veridian-hub-signature': sig });
}
const envoyer = (corpsObj: unknown, o: Parameters<typeof signer>[1] = {}) => {
  const corps = typeof corpsObj === 'string' ? corpsObj : JSON.stringify(corpsObj);
  return recevoirVisites(db as never, signer(corps, o), corps, env, NOW, crm as never);
};
/** L'appel CRM le plus récent : c'est celui du lot en cours de test. */
const argsCrm = () => JSON.parse(String((crm.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body)).params;

beforeEach(() => oublierDebit());

describe('recevoirVisites', () => {
  it('organisation neuve, liaison non réglée : allumée d\'office, le lot est relayé au CRM (app_evenements_visite, kind visite) ; le même lot rejoué : doublons, sans nouvel appel', async () => {
    await monter();
    const l = lot();
    expect(await envoyer(l)).toMatchObject({ statut: 200, corps: { acceptes: 1, doublons: 0, ignores: [], crm: { creees: 1 } } });
    expect(argsCrm()).toMatchObject({ name: 'app_evenements_visite', arguments: { kind: 'visite', visites: [{ session_id: 'sess-0001-abcd', contact_email: 'client@exemple.fr', duree_s: 60, pages_vues: 2 }] } });
    expect(await envoyer(l)).toMatchObject({ statut: 200, corps: { acceptes: 0, doublons: 1 } });
    expect(crm).toHaveBeenCalledTimes(1);
  });

  it('signature fausse : 401 ; nonce rejoué : 401 ; rien relayé', async () => {
    await monter();
    const corps = JSON.stringify(lot());
    const nonce = randomBytes(16).toString('base64url');
    const a = await recevoirVisites(db as never, signer(corps, { secret: 'un-autre-secret-de-test-trente-deux' }), corps, env, NOW, crm as never);
    const b = await recevoirVisites(db as never, signer(corps, { nonce }), corps, env, NOW, crm as never);
    const c = await recevoirVisites(db as never, signer(corps, { nonce }), corps, env, NOW, crm as never);
    expect([a.statut, b.statut, c.statut, c.corps]).toEqual([401, 200, 401, { error: 'nonce_replayed' }]);
    expect(crm).toHaveBeenCalledTimes(1);
  });

  it('corps illisible, hub_tenant_id absent : 400 ; une visite avec un champ de plus (un chaîne, une IP) est ignorée, les autres relayées', async () => {
    await monter();
    expect((await envoyer('{')).statut).toBe(400);
    expect((await envoyer({ visites: [] })).statut).toBe(400);
    const r = await envoyer(lot([visite({ chaine: ['x:1'] }), visite({ session_id: 'sess-0002-abcd' })]));
    expect(r).toMatchObject({ statut: 200, corps: { acceptes: 1, ignores: [{ index: 0, raison: 'invalide' }] } });
    expect(argsCrm().arguments.visites.map((v: { session_id: string }) => v.session_id)).toEqual(['sess-0002-abcd']);
  });

  it('liaison éteinte : accepté, rien relayé, raison dite', async () => {
    await monter({ ligne: { etat: 'eteinte', consentiLe: null, portees: null } });
    expect(await envoyer(lot())).toMatchObject({ statut: 200, corps: { acceptes: 0, raison: 'paire_eteinte' } });
    expect(crm).not.toHaveBeenCalled();
  });

  it('organisation ANCIENNE sans consentement : éteinte, rien relayé ; une fois consentie (clic du propriétaire), relayée', async () => {
    await monter({ neuve: false, ligne: null });
    expect((await envoyer(lot())).corps).toMatchObject({ raison: 'paire_eteinte' });
    await db.integrationPaire.create({ data: { tenantId: tenant, paire: 'analytics>crm#visite', etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(paire('analytics>crm#visite')!) } });
    expect(await envoyer(lot())).toMatchObject({ statut: 200, corps: { acceptes: 1 } });
  });

  it('évènements fermés pour l\'organisation (DELEGATION_EVENEMENTS) : accepté, rien relayé', async () => {
    await monter();
    env = { ...env, DELEGATION_EVENEMENTS: '' };
    expect(await envoyer(lot())).toMatchObject({ statut: 200, corps: { raison: 'evenements_fermes' } });
    env = { ...env, DELEGATION_EVENEMENTS: 'analytics>crm#visite' };
    expect(crm).not.toHaveBeenCalled();
  });

  it('plafond par organisation : 60 lots par minute, le 61e refusé en 429 avec Retry-After', async () => {
    await monter();
    for (let i = 0; i < 60; i++) expect((await envoyer(lot([visite({ session_id: `sess-${i}-abcdef` })]))).statut).toBe(200);
    expect(await envoyer(lot([visite({ session_id: 'sess-99-abcdef' })]))).toMatchObject({ statut: 429, retryAfterS: 60, corps: { error: 'rate_limited' } });
  });

  it('plus de 200 visites : 413 ; rien relayé', async () => {
    await monter();
    const r = await envoyer(lot(Array.from({ length: VISITES_MAX_LOT + 1 }, (_, i) => visite({ session_id: `sess-${i}-abcdef` }))));
    expect([r.statut, crm.mock.calls.length]).toEqual([413, 0]);
  });

  it('idempotence : une session déjà rangée dans un autre lot est un doublon, et deux fois la même dans un lot aussi', async () => {
    await monter();
    await envoyer(lot([visite()]));
    const r = await envoyer(lot([visite(), visite({ session_id: 'sess-0009-abcd' }), visite({ session_id: 'sess-0009-abcd' })]));
    expect(r).toMatchObject({ statut: 200, corps: { acceptes: 1, doublons: 2 } });
    expect(argsCrm().arguments.visites.map((v: { session_id: string }) => v.session_id)).toEqual(['sess-0009-abcd']);
  });

  it('CRM injoignable : 503, lignes libérées, le rejeu relaie ; jamais de 502', async () => {
    await monter();
    crm.mockRejectedValueOnce(new Error('réseau'));
    const l = lot();
    expect((await envoyer(l)).statut).toBe(503);
    expect(await envoyer(l)).toMatchObject({ statut: 200, corps: { acceptes: 1 } });
  });

  it('relais compté : créées, ignorées avec leur raison (contact inconnu du CRM : jamais créé), sans contact ni chemin dans le journal', async () => {
    await monter();
    crm.mockImplementationOnce(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, lignes: { creees: 0, avancees: 0, ignorees: 1 }, ignorees: [{ raison: 'contact_inconnu' }] }) }] } }), { headers: { 'content-type': 'application/json' } }));
    const r = await envoyer(lot());
    expect(r.corps).toMatchObject({ acceptes: 1, crm: { creees: 0, ignorees: 1, raisons_ignorees: { contact_inconnu: 1 } } });
    const j = JSON.stringify(db.auditLog.lignes.filter((x: { action: string }) => x.action === 'evenement.visites'));
    expect([j.includes('evenement.visites'), j.includes('@'), j.includes('/tarifs'), j.includes('sess-0001')]).toEqual([true, false, false, false]);
  });
});

describe('trierVisite', () => {
  const ok = (o: Record<string, unknown>) => (trierVisite(visite(o), NOW) as { ok: Record<string, unknown> }).ok;
  it('chemins sans requête ni fragment ; un chemin qui ne commence pas par / ou une date inversée sont refusés ; trop ancien ou futur ignorés', () => {
    expect([
      ok({}).chemins,
      trierVisite(visite({ chemins: ['tarifs'] }), NOW),
      trierVisite(visite({ fin: new Date(NOW - 200_000).toISOString(), debut: new Date(NOW - 100_000).toISOString() }), NOW),
      trierVisite(visite({ debut: new Date(NOW - 8 * 86_400_000).toISOString(), fin: new Date(NOW - 8 * 86_400_000 + 60_000).toISOString() }), NOW),
      trierVisite(visite({ fin: new Date(NOW + 10 * 60_000).toISOString() }), NOW),
    ]).toEqual([['/tarifs', '/contact'], { raison: 'chemin_invalide' }, { raison: 'date_invalide' }, { raison: 'trop_ancien' }, { raison: 'futur' }]);
  });
  it('la clé de ligne ne contient pas la session en clair', () => {
    const c = cleDeVisite(tenant, 'sess-0001-abcd');
    expect([c.evenementId.includes('sess-0001'), c.evenementId.length, c.source]).toEqual([false, 32, 'analytics-visite']);
  });
});
