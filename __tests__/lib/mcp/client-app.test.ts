// @vitest-environment node
/** Client MCP vers les apps : ce que le Hub envoie, ce qu'il accepte de lire, et comment il nomme un refus. */
import { describe, expect, it, vi } from 'vitest';

import { AppDebit, AppInjoignable, CompteAbsent, SessionApp } from '@/lib/mcp/client-app';

type Envoi = { headers: Record<string, string>; corps: { method: string; params?: Record<string, unknown> }; signal?: AbortSignal };
/** Une app : `repondre` décide de la réponse d'un tools/call ; le reste est normal. */
function app(repondre: (id: number) => Response, envois: Envoi[] = []) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const corps = JSON.parse(String(init.body)) as { id: number; method: string; params?: Record<string, unknown> };
    envois.push({ headers: init.headers as Record<string, string>, corps, signal: init.signal ?? undefined });
    return corps.method === 'tools/call' ? repondre(corps.id) : Response.json({ jsonrpc: '2.0', id: corps.id, result: {} }, { headers: { 'mcp-session-id': 's-1' } });
  }) as unknown as typeof fetch;
}
const ok = (id: number, result: unknown = { content: [] }) => Response.json({ jsonrpc: '2.0', id, result });
const erreurDe = (p: Promise<unknown>) => p.then(() => { throw new Error('aucune erreur'); }, (e: unknown) => e);

describe('SessionApp, hors programme', () => {
  it('n\'annonce rien de plus : ni en-tête de programme, ni borne de taille', async () => {
    const envois: Envoi[] = [];
    const s = new SessionApp('https://app.test/mcp', 'j', app((id) => ok(id, { gros: 'x'.repeat(2_000_000) }), envois));
    await s.ouvrir();
    expect(((await s.appeler('lire', {})) as { gros: string }).gros).toHaveLength(2_000_000);
    for (const e of envois) expect(Object.keys(e.headers).map((h) => h.toLowerCase())).not.toContain('x-veridian-mcp-appel');
    expect(envois.at(-1)?.headers).toMatchObject({ Authorization: 'Bearer j', 'Mcp-Session-Id': 's-1' });
  });
});

describe('délais', () => {
  it('un outil a 60 s, le reste 15 s ; un outil coupé dit que l\'action a peut-être eu lieu', async () => {
    const delais: number[] = [];
    const vrai = AbortSignal.timeout.bind(AbortSignal);
    const espion = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { delais.push(ms); return vrai(ms === 60_000 ? 20 : ms); });
    try {
      const s = new SessionApp('https://app.test/mcp', 'j', (async (_u: string, init: RequestInit) => {
        const corps = JSON.parse(String(init.body)) as { id: number; method: string };
        if (corps.method !== 'tools/call') return Response.json({ jsonrpc: '2.0', id: corps.id, result: {} });
        return new Promise<Response>((_ok, non) => init.signal!.addEventListener('abort', () => non(init.signal!.reason)));
      }) as typeof fetch);
      await s.ouvrir();
      const e = (await erreurDe(s.appeler('install_app', {}))) as Error;
      expect(e).toBeInstanceOf(AppInjoignable);
      expect(e.message).toMatch(/60 s : l'action a peut-être eu lieu/);
      expect([...new Set(delais)]).toEqual([15_000, 60_000]);
    } finally {
      espion.mockRestore();
    }
  });
  it('une panne réseau avant le délai reste une panne, sans ce doute', async () => {
    const s = new SessionApp('https://app.test/mcp', 'j', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(((await erreurDe(s.appeler('x', {}))) as Error).message).toBe('ECONNREFUSED');
  });
});

describe('SessionApp, en programme', () => {
  const options = { entetes: { 'X-Veridian-MCP-Appel': 'programme' }, maxOctets: 1_000 };

  it('l\'en-tête est sur chaque requête et ne remplace jamais l\'identité', async () => {
    const envois: Envoi[] = [];
    const s = new SessionApp('https://app.test/mcp', 'j', app((id) => ok(id), envois), options);
    await s.ouvrir();
    await s.appeler('lire', { a: 1 });
    for (const e of envois) expect(e.headers).toMatchObject({ 'X-Veridian-MCP-Appel': 'programme', Authorization: 'Bearer j' });
    expect(envois.at(-1)?.corps).toMatchObject({ method: 'tools/call', params: { name: 'lire', arguments: { a: 1 } } });
  });

  it('une réponse trop grosse est abandonnée en cours de lecture, avec un conseil', async () => {
    let lus = 0;
    const corps = new ReadableStream<Uint8Array>({ pull(c) { lus += 1; c.enqueue(new Uint8Array(600).fill(120)); } });
    const s = new SessionApp('https://app.test/mcp', 'j', app(() => new Response(corps, { headers: { 'content-type': 'application/json' } })), options);
    const e = await erreurDe(s.appeler('lire', {}));
    expect(e).toBeInstanceOf(AppInjoignable);
    expect((e as Error).message).toContain('plus de 1000 octets');
    expect(lus, 'flux infini : on ne lit pas plus loin que la borne').toBeLessThan(6);
  });

  it('une réponse sous la borne passe entière, accents compris', async () => {
    const s = new SessionApp('https://app.test/mcp', 'j', app((id) => ok(id, { t: 'é'.repeat(300) })), options);
    expect(await s.appeler('lire', {})).toEqual({ t: 'é'.repeat(300) });
  });

  it('l\'échéance du programme abandonne l\'appel en vol', async () => {
    const abandon = new AbortController();
    const jamais = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_ok, non) => init.signal!.addEventListener('abort', () => non(new Error('abandonné'))))) as unknown as typeof fetch;
    const p = erreurDe(new SessionApp('https://app.test/mcp', 'j', jamais, { signal: abandon.signal }).appeler('lire', {}));
    abandon.abort();
    expect(await p).toBeInstanceOf(AppInjoignable);
  });
});

describe('les refus d\'une app', () => {
  it('429 : AppDebit, avec le délai demandé, borné à une minute, 2 s par défaut', async () => {
    const attente = async (h?: string) => ((await erreurDe(new SessionApp('https://a.test', 'j', app(() => new Response('', { status: 429, headers: h ? { 'retry-after': h } : {} }))).appeler('x', {}))) as AppDebit).attenteMs;
    expect([await attente('3'), await attente('9999'), await attente(), await attente('demain')]).toEqual([3_000, 60_000, 2_000, 2_000]);
  });

  it('compte inconnu : CompteAbsent ; espace refusé : dit lequel ; corps illisible : AppInjoignable', async () => {
    const avec = (r: Response) => erreurDe(new SessionApp('https://a.test', 'j', app(() => r)).appeler('x', {}));
    expect(await avec(new Response('{"error":"hub_user_unknown"}', { status: 403 }))).toBeInstanceOf(CompteAbsent);
    expect(((await avec(new Response('tenant_forbidden', { status: 403 }))) as Error).message).toContain('pas membre');
    const illisible = await avec(new Response('<html>', { headers: { 'content-type': 'application/json' } }));
    expect(illisible).toBeInstanceOf(AppInjoignable);
    expect(illisible).not.toBeInstanceOf(AppDebit);
  });
});
