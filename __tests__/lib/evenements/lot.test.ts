/** Activité Mail par lots (CONTRAT-HUB §5.25) : signature de l'espace, bornes, dédoublonnage du lot, tri des événements, relais au CRM. */
import { createHmac, randomUUID } from 'node:crypto';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { empreintePortees, paire } from '@/lib/delegation/paires';
import { poserAbonnement } from '@/lib/evenements/abonnement';
import { recevoirLot, trierEvenement } from '@/lib/evenements/lot';

import { base, cleDeTest } from './fausse';

const SECRET = `whsec_${Buffer.from('secret-de-test-32-octets-minimum!').toString('base64')}`;
const AUTRE = `whsec_${Buffer.from('un-autre-secret-32-octets-minimum').toString('base64')}`;
const NOW = 1_800_000_000_000;
const ISO = new Date(NOW - 60_000).toISOString();
let env: NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
let crm: ReturnType<typeof vi.fn>;

beforeAll(async () => { env = { ...(await cleDeTest()), DELEGATION_EVENEMENTS: 'notifuse>crm#activite' }; });
beforeEach(async () => {
  db = base();
  crm = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true,"lignes":{"creees":1,"avancees":0,"ignorees":0}}' }] } }), { headers: { 'content-type': 'application/json' } }));
  await db.tenant.create({ data: { id: 'T', userId: 'u', status: 'active', deletedAt: null, metadata: null } });
  await db.mcpApp.create({ data: { appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true } });
  await db.integrationPaire.create({ data: { tenantId: 'T', paire: 'notifuse>crm#activite', etat: 'allumee', consentiLe: new Date(), portees: empreintePortees(paire('notifuse>crm#activite')!) } });
  await poserAbonnement(db as never, { tenantId: 'T', source: 'notifuse', cleExterne: 'ws1', secret: SECRET }, env);
});

const ev = (o: Record<string, unknown> = {}) => ({ event: 'message.sent', occurred_at: ISO, rfc_message_id: '<A@Mail.Test>', thread_id: 't1', recipient_email: 'Client@Exemple.fr', from_email: 'nous@veridian.site', from_name: 'Veridian', subject: 'Offre', nature: 'campaign', ...o });
const envoyer = (lot: Record<string, unknown>, o: { secret?: string; id?: string } = {}) => {
  const corps = JSON.stringify(lot);
  const ts = NOW / 1000;
  const id = o.id ?? String(lot.lot_id);
  const sig = createHmac('sha256', Buffer.from((o.secret ?? SECRET).replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${corps}`).digest('base64');
  return recevoirLot(db as never, new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` }), corps, env, NOW, crm as never);
};
const lot = (evenements: unknown[], o: Record<string, unknown> = {}) => ({ workspace_id: 'ws1', lot_id: randomUUID(), evenements, ...o });
const argsCrm = () => JSON.parse(String((crm.mock.calls[0] as unknown as [string, RequestInit])[1].body)).params;

describe('recevoirLot', () => {
  it('un lot signé par l\'espace est relayé au CRM (app_evenements_mail, portée crm:mail.ecrire) ; le même lot rejoué : doublons, sans nouvel appel', async () => {
    const l = lot([ev(), ev({ event: 'message.opened' })]);
    expect(await envoyer(l)).toMatchObject({ statut: 200, corps: { acceptes: 2, doublons: 0, ignores: [], crm: { creees: 1 } } });
    expect(argsCrm()).toMatchObject({ name: 'app_evenements_mail', arguments: { workspace_id: 'ws1', evenements: [{ recipient_email: 'client@exemple.fr', rfc_message_id: '<a@mail.test>' }, { event: 'message.opened' }] } });
    expect(await envoyer(l)).toMatchObject({ statut: 200, corps: { acceptes: 0, doublons: 2 } });
    expect(crm).toHaveBeenCalledTimes(1);
  });
  it('signé par un autre espace : 401 ; webhook-id différent du lot : 400 ; 201 événements : 413 ; hub_tenant_id faux : 409 ; rien relayé', async () => {
    const statuts = [
      (await envoyer(lot([ev()]), { secret: AUTRE })).statut,
      (await envoyer(lot([ev()]), { id: randomUUID() })).statut,
      (await envoyer(lot(Array.from({ length: 201 }, () => ev())))).statut,
      (await envoyer(lot([ev()], { hub_tenant_id: randomUUID() }))).statut,
    ];
    expect([statuts, crm.mock.calls.length]).toEqual([[401, 400, 413, 409], 0]);
  });
  it('liaison éteinte ou ouverture fermée : accepté au Hub, rien relayé, la raison est dite', async () => {
    db.integrationPaire.lignes[0].etat = 'eteinte';
    expect(await envoyer(lot([ev()]))).toMatchObject({ statut: 200, corps: { acceptes: 0, raison: 'paire_eteinte' } });
    env = { ...env, DELEGATION_EVENEMENTS: 'notifuse>crm' };
    expect(await envoyer(lot([ev()]))).toMatchObject({ corps: { raison: 'evenements_fermes' } });
    env = { ...env, DELEGATION_EVENEMENTS: 'notifuse>crm#activite' };
    expect(crm).not.toHaveBeenCalled();
  });
  it('CRM injoignable : 503 et le lot est libéré (le rejeu relaie) ; jamais de 502', async () => {
    crm.mockRejectedValueOnce(new Error('réseau'));
    const l = lot([ev()]);
    expect((await envoyer(l)).statut).toBe(503);
    expect(await envoyer(l)).toMatchObject({ statut: 200, corps: { acceptes: 1 } });
  });
  it('aucune adresse dans le journal : le lot, les comptes, le jeton', async () => {
    await envoyer(lot([ev()]));
    const j = JSON.stringify(db.auditLog.lignes.filter((x: { action: string }) => x.action === 'evenement.lot'));
    expect([j.includes('evenement.lot'), j.includes('@')]).toEqual([true, false]);
  });
});

describe('trierEvenement', () => {
  it('sujet tronqué à 200, l\'hôte seul pour un clic (jamais un chemin ni des paramètres), trop ancien ou futur ignorés', () => {
    const ok = (o: Record<string, unknown>) => (trierEvenement(ev(o), NOW) as { ok: Record<string, unknown> }).ok;
    expect([
      (ok({ subject: 'x'.repeat(500) }).subject as string).length,
      ok({ event: 'message.clicked', host: 'Exemple.fr' }).host,
      ok({ event: 'message.clicked', host: 'exemple.fr/r?jeton=abc' }).host,
      ok({ host: 'exemple.fr' }).host,
      trierEvenement(ev({ occurred_at: new Date(NOW - 8 * 86_400_000).toISOString() }), NOW),
      trierEvenement(ev({ occurred_at: new Date(NOW + 10 * 60_000).toISOString() }), NOW),
      trierEvenement(ev({ event: 'message.autre' }), NOW),
    ]).toEqual([200, 'exemple.fr', null, null, { raison: 'trop_ancien' }, { raison: 'futur' }, { raison: 'invalide' }]);
  });
});
