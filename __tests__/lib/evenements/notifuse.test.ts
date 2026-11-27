import { createHmac } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { empreintePortees, paire } from '@/lib/delegation/paires';
import { poserAbonnement } from '@/lib/evenements/abonnement';
import { recevoirNotifuse } from '@/lib/evenements/notifuse';

import { base, cleDeTest } from './fausse';

const SECRET = `whsec_${Buffer.from('secret-de-test-32-octets-minimum!').toString('base64')}`;
const NOW = 1_800_000_000_000;
let env: NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
let crm: ReturnType<typeof vi.fn>;

beforeAll(async () => { env = { ...(await cleDeTest()), DELEGATION_EVENEMENTS: 'notifuse>crm' }; });
beforeEach(async () => {
  db = base();
  crm = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true,"rejoue":false}' }] } }), { headers: { 'content-type': 'application/json' } }));
  await db.tenant.create({ data: { id: 'T', userId: 'u', status: 'active', deletedAt: null, metadata: null } });
  await db.mcpApp.create({ data: { appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true } });
  await db.integrationPaire.create({ data: { tenantId: 'T', paire: 'notifuse>crm', etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(paire('notifuse>crm')!) } });
  await poserAbonnement(db as never, { tenantId: 'T', source: 'notifuse', cleExterne: 'ws1', secret: SECRET }, env);
});

const evt = (id = 'liv-1', data: Record<string, unknown> = {}) => ({ id, type: 'message.received', workspace_id: 'ws1', timestamp: '2026-11-24T16:49:52Z', data: { message_id: `m-${id}`, rfc_message_id: `${id}@x.test`, kind: 'reply_human', match_type: 'message_id', direction: 'in', email: 'c@x.test', subject: 'Re: confidentiel', thread_id: 't_1', event_timestamp: '2026-11-24T16:49:50Z', ...data } });
const envoyer = (e: unknown, o: { secret?: string; ts?: number; env?: NodeJS.ProcessEnv } = {}) => {
  const corps = JSON.stringify(e);
  const ts = o.ts ?? NOW / 1000;
  const id = (e as { id: string }).id;
  const sig = createHmac('sha256', Buffer.from((o.secret ?? SECRET).replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${corps}`).digest('base64');
  return recevoirNotifuse(db as never, new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` }), corps, o.env ?? env, NOW, crm as never);
};

describe('recevoirNotifuse', () => {
  it('une vraie réponse crée exactement une écriture au CRM, et le même événement rejoué n\'en crée pas', async () => {
    expect(await envoyer(evt())).toMatchObject({ statut: 200, corps: { ok: true, effet: 'cree' } });
    expect(crm).toHaveBeenCalledTimes(1);
    expect(await envoyer(evt())).toMatchObject({ statut: 200, corps: { effet: 'aucun', raison: 'deja_traite' } });
    expect(await envoyer(evt('liv-2', { message_id: 'm-liv-1', rfc_message_id: null }))).toMatchObject({ corps: { raison: 'deja_traite' } });
    expect(crm).toHaveBeenCalledTimes(1);
    expect(db.integrationPaire.lignes[0]).toMatchObject({ derniereErreur: null });
    expect(db.integrationPaire.lignes[0].dernierPassage).toBeInstanceOf(Date);
  });
  it('organisation neuve, sans réglage : active par défaut, le passage se garde ; existante : rien', async () => {
    db.integrationPaire.lignes.length = 0;
    Object.assign(db.tenant.lignes[0], { notifuseWorkspaceSlug: 'ws1', metadata: { crm: { workspace_id: 'w' } }, createdAt: new Date('2026-06-01') });
    expect(await envoyer(evt('d0'))).toMatchObject({ corps: { raison: 'paire_eteinte' } });
    db.tenant.lignes[0].createdAt = new Date('2026-11-26T08:00:00Z');
    expect(await envoyer(evt('d1'))).toMatchObject({ statut: 200, corps: { effet: 'cree' } });
    expect(db.integrationPaire.lignes[0]).toMatchObject({ etat: 'defaut', dernierPassage: expect.any(Date) });
  });
  it('le CRM n\'a rien à faire (ignore) ou l\'a déjà (rejoue) : succès, pas d\'écriture comptée, et l\'événement ne revient pas', async () => {
    const rendre = (o: object) => crm.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } }), { headers: { 'content-type': 'application/json' } }));
    rendre({ ok: true, ignore: true, raison: 'tache_deja_ouverte' });
    expect(await envoyer(evt('i1'))).toMatchObject({ statut: 200, corps: { effet: 'aucun', raison: 'crm_tache_deja_ouverte' } });
    expect(db.evenementRecu.lignes[0]).toMatchObject({ etat: 'ignore', raison: 'tache_deja_ouverte' });
    // La raison du CRM part aussi au journal (27/11 : deux réponses « aucun » sans raison lisible au Hub).
    expect(db.auditLog.lignes.find((x: { action: string }) => x.action === 'evenement.recu')).toMatchObject({ payload: { effet: 'aucun', raison: 'tache_deja_ouverte' } });
    rendre({ ok: true, rejoue: true });
    expect(await envoyer(evt('i2'))).toMatchObject({ statut: 200, corps: { effet: 'rejoue' } });
    expect(db.integrationLien.lignes).toHaveLength(0);
    expect(await envoyer(evt('i1'))).toMatchObject({ corps: { raison: 'deja_traite' } });
    expect(crm).toHaveBeenCalledTimes(2);
  });
  it.each([
    [503, 'app_installing', 503, 60],
    [503, 'app_install_failed', 503, 60],
    [403, 'app_uninstalled', 503, undefined],
    [403, 'app_not_available', 503, undefined],
    [403, 'tenant_not_linked', 503, undefined],
    [403, 'workspace_inactive', 503, undefined],
  ])('refus %s %s : dit tel quel, la source réessaie avec un jeton neuf, la ligne est libérée', async (http, code, statut, retryAfterS) => {
    crm.mockImplementation(async () => new Response(JSON.stringify({ statusCode: http, error: { code } }), { status: http }));
    expect(await envoyer(evt('r'))).toEqual({ statut, corps: { error: `crm_${code}` }, retryAfterS });
    expect(db.integrationPaire.lignes[0].derniereErreur).toBe(`crm_${code}`);
    expect(db.evenementRecu.lignes).toHaveLength(0);
    await envoyer(evt('r'));
    const jetons = crm.mock.calls.map((c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization);
    expect(new Set(jetons).size).toBe(2);
  });
  it('signature fausse, mauvais secret, hors fenêtre, abonnement inconnu : rien n\'arrive', async () => {
    expect((await envoyer(evt(), { secret: `whsec_${Buffer.from('autre-secret-de-test-32-octets!!').toString('base64')}` })).statut).toBe(401);
    expect((await envoyer(evt(), { ts: NOW / 1000 - 400 })).statut).toBe(401);
    expect((await envoyer({ ...evt(), workspace_id: 'inconnu' })).statut).toBe(401);
    expect((await recevoirNotifuse(db as never, new Headers(), '{"workspace_id":"ws1"}', env, NOW, crm as never)).statut).toBe(400);
    expect((await recevoirNotifuse(db as never, new Headers(), 'pas du json', env, NOW, crm as never)).statut).toBe(400);
    expect(crm).not.toHaveBeenCalled();
    expect(db.evenementRecu.lignes).toHaveLength(0);
  });
  it('réponse automatique, rebond, accusé, contact qui n\'a pas répondu : acquittés sans effet', async () => {
    for (const d of [{ kind: 'reply_auto' }, { kind: 'bounce_hard' }, { kind: 'dsn' }, { match_type: 'sender' }]) expect(await envoyer(evt(`x${Object.values(d)[0]}`, d))).toMatchObject({ statut: 200, corps: { effet: 'aucun' } });
    expect(crm).not.toHaveBeenCalled();
  });
  it('drapeau vide, paire éteinte, élargie, organisation suspendue ou supprimée : acquitté sans effet, rien de consommé', async () => {
    expect(await envoyer(evt('a'), { env: { ...env, DELEGATION_EVENEMENTS: '' } })).toMatchObject({ corps: { raison: 'evenements_fermes' } });
    expect(await envoyer(evt('b'), { env: { ...env, DELEGATION_CIBLES: 'crm,notifuse', DELEGATION_EVENEMENTS: undefined } })).toMatchObject({ corps: { raison: 'evenements_fermes' } });
    db.integrationPaire.lignes[0].etat = 'eteinte';
    expect(await envoyer(evt('c'))).toMatchObject({ corps: { raison: 'paire_eteinte' } });
    db.integrationPaire.lignes[0].etat = 'allumee';
    db.integrationPaire.lignes[0].portees = 'ancienne';
    expect(await envoyer(evt('d'))).toMatchObject({ corps: { raison: 'paire_eteinte' } });
    db.integrationPaire.lignes[0].portees = empreintePortees(paire('notifuse>crm')!);
    db.tenant.lignes[0].status = 'suspended';
    expect(await envoyer(evt('e'))).toMatchObject({ corps: { raison: 'organisation_inactive' } });
    db.tenant.lignes[0].status = 'active';
    db.tenant.lignes[0].deletedAt = new Date();
    expect(await envoyer(evt('f'))).toMatchObject({ corps: { raison: 'organisation_inactive' } });
    expect(crm).not.toHaveBeenCalled();
    expect(db.evenementRecu.lignes).toHaveLength(0);
    db.tenant.lignes[0].deletedAt = null;
    expect((await envoyer(evt('g'))).corps).toMatchObject({ effet: 'cree' });
  });
  it('`notifuse>crm@test` n\'ouvre qu\'une organisation marquée de test', async () => {
    const e = { ...env, DELEGATION_EVENEMENTS: 'notifuse>crm@test' };
    expect(await envoyer(evt('a'), { env: e })).toMatchObject({ corps: { raison: 'evenements_fermes' } });
    db.tenant.lignes[0].metadata = { organisation_de_test: { expire_le: new Date(NOW + 3_600_000).toISOString() } };
    expect((await envoyer(evt('b'), { env: e })).corps).toMatchObject({ effet: 'cree' });
  });
  it('le CRM injoignable : 5xx, rien de gardé, et le réessai de la source aboutit une seule fois', async () => {
    crm.mockResolvedValueOnce(new Response('{}', { status: 502 }));
    const r = await envoyer(evt());
    expect(r.statut).toBe(503);
    expect(db.evenementRecu.lignes).toHaveLength(0);
    expect(db.integrationLien.lignes).toHaveLength(0);
    expect(db.integrationPaire.lignes[0].derniereErreur).toBe('crm_injoignable');
    expect((await envoyer(evt())).corps).toMatchObject({ effet: 'cree' });
    expect(await envoyer(evt())).toMatchObject({ corps: { raison: 'deja_traite' } });
    expect(db.integrationPaire.lignes[0].derniereErreur).toBeNull();
  });
  // Recette du 26/11 en prod : liaison active PAR DÉFAUT, donc sans ligne ; l'erreur du CRM ne s'écrivait nulle part, et le 502 était masqué
  // par la page de Cloudflare. Désormais 503 avec le code, et l'audit garde l'échec (ni adresse ni contenu).
  it('liaison active par défaut, sans ligne : l\'échec du CRM répond 503 avec son code et reste dans l\'audit', async () => {
    db.integrationPaire.lignes.length = 0;
    Object.assign(db.tenant.lignes[0], { notifuseWorkspaceSlug: 'ws1', metadata: { crm: { workspace_id: 'w' } }, createdAt: new Date('2026-11-26T08:00:00Z') });
    crm.mockImplementation(async () => new Response(JSON.stringify({ statusCode: 403, error: { code: 'tenant_not_linked' } }), { status: 403 }));
    const r = await envoyer(evt('sans-ligne'));
    expect(r).toMatchObject({ statut: 503, corps: { error: 'crm_tenant_not_linked' } });
    const echec = db.auditLog.lignes.find((l: { action: string }) => l.action === 'evenement.echec');
    expect(echec).toMatchObject({ payload: { paire: 'notifuse>crm', evenement_id: 'sans-ligne', erreur: 'crm_tenant_not_linked' } });
    expect(JSON.stringify(echec)).not.toMatch(/@/);
    // L'erreur se lit sur la liaison, qui reste « par défaut » (aucun état figé).
    expect(db.integrationPaire.lignes[0]).toMatchObject({ etat: 'defaut', derniereErreur: 'crm_tenant_not_linked' });
  });
  it('le CRM qui limite le débit : 503 avec Retry-After ; un CRM muet (pas de résultat) n\'est jamais un 2xx', async () => {
    crm.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '7' } }));
    expect(await envoyer(evt())).toMatchObject({ statut: 503, retryAfterS: 7 });
    crm.mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), { headers: { 'content-type': 'application/json' } }));
    expect((await envoyer(evt())).statut).toBe(503);
  });
  it('un même contact : six réponses en 10 min, la sixième met la paire en pause visible et n\'écrit rien ; ensuite plus rien', async () => {
    for (let i = 1; i <= 5; i++) expect((await envoyer(evt(`r${i}`))).corps).toMatchObject({ effet: 'cree' });
    expect(await envoyer(evt('r6'))).toMatchObject({ corps: { raison: 'pause_disjoncteur' } });
    expect(await envoyer(evt('r7', { email: 'autre@x.test' }))).toMatchObject({ corps: { raison: 'pause_disjoncteur' } });
    expect(crm).toHaveBeenCalledTimes(5);
    expect(db.integrationPaire.lignes[0].derniereErreur).toBe('pause_disjoncteur');
  });
  it('un échec n\'est pas compté comme une écriture ; l\'audit et la base ne gardent ni adresse, ni objet, ni secret', async () => {
    await envoyer(evt('liv-1', { subject: 'Re: objet-confidentiel' }));
    const tout = JSON.stringify([db.evenementRecu.lignes, db.integrationLien.lignes, db.auditLog.lignes, db.evenementAbonnement.lignes, db.integrationPaire.lignes, db.integrationPause.lignes]);
    for (const interdit of ['c@x.test', 'confidentiel', 'secret-de-test', SECRET.slice(6)]) expect(tout).not.toContain(interdit);
    expect(db.auditLog.lignes[0]).toMatchObject({ action: 'evenement.recu', payload: { paire: 'notifuse>crm', evenement_id: 'liv-1' } });
  });
});
