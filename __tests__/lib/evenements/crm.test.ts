import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ecrireEvenementsMail, OUTIL_CRM_MAIL, PORTEE_CRM_MAIL, ecrireReponseHumaine, OUTIL_CRM, PORTEE_CRM } from '@/lib/evenements/crm';
import { jwksPublic } from '@/lib/mcp/identite';

import { base, cleDeTest } from './fausse';

const R = { workspaceId: 'ws1', evenementId: 'liv-1', messageId: 'm-1', rfcMessageId: 'abc@x', email: 'c@x.test', threadId: 't_1', survenuLe: null, nom: null as string | null };
let env: NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
beforeAll(async () => { env = await cleDeTest(); });
beforeEach(async () => {
  db = base();
  await db.mcpApp.create({ data: { appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true } });
});
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const OK = { content: [{ type: 'text', text: JSON.stringify({ success: true, result: { ok: true, rejoue: false, tache: 't' } }) }] };
const appel = (f: typeof fetch) => ecrireReponseHumaine(db as never, { tenantId: 'T', reponse: R, chaine: [] }, env, f);

describe('ecrireReponseHumaine', () => {
  it('jeton : sujet integration:<tenant>, act notifuse, portée exacte, 120 s, tenant_id, jti, aucune adresse', async () => {
    const f = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: OK }));
    const { jti } = await appel(f as never);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    const p = (await jwtVerify(h.Authorization.slice(7), createLocalJWKSet((await jwksPublic(env)) as { keys: JWK[] }), { audience: 'https://crm.test/mcp' })).payload;
    expect(url).toBe('https://crm.test/mcp');
    expect(p).toMatchObject({ sub: 'integration:T', act: { sub: 'app:notifuse' }, scope: PORTEE_CRM, tenant_id: 'T', jti });
    expect(p.exp! - p.iat!).toBe(120);
    expect(p).not.toHaveProperty('email');
    expect(PORTEE_CRM).toBe('crm:tache.ecrire');
  });
  it('tools/call direct, sans initialize ; Accept json et SSE ; clé d\'idempotence ; ni objet ni corps', async () => {
    const f = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: OK }));
    await appel(f as never);
    expect(f).toHaveBeenCalledTimes(1);
    const init = f.mock.calls[0][1] as unknown as RequestInit;
    const h = init.headers as Record<string, string>;
    expect([h.Accept, h['Idempotency-Key']]).toEqual(['application/json, text/event-stream', 'liv-1']);
    const corps = JSON.parse(init.body as string);
    expect(corps).toMatchObject({ method: 'tools/call', params: { name: OUTIL_CRM, arguments: { email: 'c@x.test', thread_id: 't_1', message_id: 'm-1', idempotency_key: 'liv-1', chaine: ['notifuse>crm:liv-1'] } } });
    expect(JSON.stringify(corps)).not.toMatch(/subject|body|from/);
  });
  it('nom affiché de l\'expéditeur : relayé quand Mail le donne (VER-247), absent sinon (jamais une clé vide)', async () => {
    const lire = async (nom: string | null) => {
      const f = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: OK }));
      await ecrireReponseHumaine(db as never, { tenantId: 'T', reponse: { ...R, nom }, chaine: [] }, env, f as never);
      return JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).params.arguments;
    };
    const avec = await lire('Alice Martin');
    const sans = await lire(null);
    expect([avec.nom, 'nom' in sans]).toEqual(['Alice Martin', false]);
  });
  it('réponse en flux SSE : acceptée', async () => {
    const sse = new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await expect(appel((async () => sse) as never)).resolves.toHaveProperty('jti');
  });
  it('un refus en 200 sans drapeau d\'erreur (success:false dans le texte) est un échec ; un succès passe', async () => {
    const dire = (t: object) => appel((async () => json({ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(t) }] } })) as never);
    await expect(dire({ success: false, message: 'Tool "app_reponse_humaine" not found' })).rejects.toThrow('crm_refus');
    await expect(dire({ success: true, result: { ok: true, tache: 't' } })).resolves.toMatchObject({ effet: 'cree' });
    await expect(dire({ success: true, result: { ok: false } })).rejects.toThrow('crm_refus');
  });
  it('l\'issue se lit, à plat, enveloppée, en texte dans du texte ou structurée ; sans « ok », ce n\'est pas un succès', async () => {
    const rendre = (result: object) => appel((async () => json({ jsonrpc: '2.0', id: 1, result })) as never);
    const texte = (t: unknown) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });
    await expect(rendre(texte({ ok: true, rejoue: true }))).resolves.toMatchObject({ effet: 'rejoue' });
    await expect(rendre(texte({ success: true, result: JSON.stringify({ ok: true, ignore: true, raison: 'reglage_coupe' }) }))).resolves.toMatchObject({ effet: 'aucun', raison: 'reglage_coupe' });
    await expect(rendre({ content: [], structuredContent: { ok: true } })).resolves.toMatchObject({ effet: 'cree' });
    await expect(rendre(texte({ ok: true, ignore: true, raison: '<b>x</b>' }))).resolves.toMatchObject({ raison: 'bxb' });
    for (const t of [{ content: [] }, texte('ok'), texte({ success: true, message: 'ok' }), texte({ ok: 'true' }), texte('{"ok":true')]) await expect(rendre(t), JSON.stringify(t)).rejects.toThrow('crm_refus');
  });
  it('sans fil, le message fait son propre fil : le CRM exige thread_id', async () => {
    const f = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: OK }));
    await ecrireReponseHumaine(db as never, { tenantId: 'T', reponse: { ...R, threadId: null }, chaine: [] }, env, f as never);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).params.arguments.thread_id).toBe('m-1');
  });
  it('pas de réponse du CRM : échec (jamais un succès par défaut) : HTTP 500, 403, erreur MCP, isError, résultat absent, réseau', async () => {
    const cas = [() => json({}, 500), () => json({}, 403), () => json({ jsonrpc: '2.0', id: 1, error: { message: 'x' } }), () => json({ jsonrpc: '2.0', id: 1, result: { isError: true } }), () => json({ jsonrpc: '2.0', id: 1 })];
    for (const c of cas) await expect(appel((async () => c()) as never)).rejects.toThrow();
    await expect(appel((async () => { throw new Error('coupé'); }) as never)).rejects.toThrow();
  });
  it('CRM non enregistré ou éteint : échec sans appel', async () => {
    db.mcpApp.lignes[0].enabled = false;
    const f = vi.fn();
    await expect(appel(f as never)).rejects.toThrow('target_not_registered');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('ecrireEvenementsMail (§5.25)', () => {
  const lignes = (o: object) => vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } }));
  it('jeton d\'intégration à la seule portée crm:mail.ecrire, outil app_evenements_mail, Idempotency-Key = lot_id ; les comptes du CRM rendus', async () => {
    const f = lignes({ ok: true, lignes: { creees: 1, avancees: 2, ignorees: 3 } });
    const r = await ecrireEvenementsMail(db as never, { tenantId: 'T', workspaceId: 'ws1', lotId: 'lot-1', evenements: [{ event: 'message.sent' }] }, env, f as never);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    const h = init.headers as Record<string, string>;
    const p = (await jwtVerify(h.Authorization.slice(7), createLocalJWKSet((await jwksPublic(env)) as { keys: JWK[] }), { audience: 'https://crm.test/mcp' })).payload;
    expect([OUTIL_CRM_MAIL, PORTEE_CRM_MAIL, p.scope, p.sub, h['Idempotency-Key'], JSON.parse(init.body as string).params.name, r.lignes]).toEqual(['app_evenements_mail', 'crm:mail.ecrire', 'crm:mail.ecrire', 'integration:T', 'lot-1', 'app_evenements_mail', { creees: 1, avancees: 2, ignorees: 3 }]);
  });
  it('un refus du CRM (success:false) lève ; des comptes absents ou faux valent 0', async () => {
    await expect(ecrireEvenementsMail(db as never, { tenantId: 'T', workspaceId: 'ws1', lotId: 'l', evenements: [] }, env, lignes({ success: false }) as never)).rejects.toThrow('crm_refus');
    expect((await ecrireEvenementsMail(db as never, { tenantId: 'T', workspaceId: 'ws1', lotId: 'l', evenements: [] }, env, lignes({ ok: true, lignes: { creees: -1, avancees: 'x' } }) as never)).lignes).toEqual({ creees: 0, avancees: 0, ignorees: 0 });
  });
});

