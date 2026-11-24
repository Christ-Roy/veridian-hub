import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ecrireReponseHumaine, OUTIL_CRM, PORTEE_CRM } from '@/lib/evenements/crm';
import { jwksPublic } from '@/lib/mcp/identite';

import { base, cleDeTest } from './fausse';

const R = { workspaceId: 'ws1', evenementId: 'liv-1', messageId: 'm-1', rfcMessageId: 'abc@x', email: 'c@x.test', threadId: 't_1', survenuLe: null };
let env: NodeJS.ProcessEnv;
let db: ReturnType<typeof base>;
beforeAll(async () => { env = await cleDeTest(); });
beforeEach(async () => {
  db = base();
  await db.mcpApp.create({ data: { appKey: 'twenty', mcpUrl: 'https://crm.test/mcp', enabled: true } });
});
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const appel = (f: typeof fetch) => ecrireReponseHumaine(db as never, { tenantId: 'T', reponse: R, chaine: [] }, env, f);

describe('ecrireReponseHumaine', () => {
  it('jeton : sujet integration:<tenant>, act notifuse, portée exacte, 120 s, tenant_id, jti, aucune adresse', async () => {
    const f = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
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
    const f = vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
    await appel(f as never);
    expect(f).toHaveBeenCalledTimes(1);
    const init = f.mock.calls[0][1] as unknown as RequestInit;
    const h = init.headers as Record<string, string>;
    expect([h.Accept, h['Idempotency-Key']]).toEqual(['application/json, text/event-stream', 'liv-1']);
    const corps = JSON.parse(init.body as string);
    expect(corps).toMatchObject({ method: 'tools/call', params: { name: OUTIL_CRM, arguments: { email: 'c@x.test', thread_id: 't_1', message_id: 'm-1', idempotency_key: 'liv-1', chaine: ['notifuse>crm:liv-1'] } } });
    expect(JSON.stringify(corps)).not.toMatch(/subject|body|from/);
  });
  it('réponse en flux SSE : acceptée', async () => {
    const sse = new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await expect(appel((async () => sse) as never)).resolves.toHaveProperty('jti');
  });
  it('un refus en 200 sans drapeau d\'erreur (success:false dans le texte) est un échec ; un succès passe', async () => {
    const dire = (t: object) => appel((async () => json({ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(t) }] } })) as never);
    await expect(dire({ success: false, message: 'Tool "app_reponse_humaine" not found' })).rejects.toThrow('crm_refus');
    await expect(dire({ success: true, message: 'ok' })).resolves.toHaveProperty('jti');
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
