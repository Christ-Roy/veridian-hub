/**
 * Client MCP minimal (Streamable HTTP) vers le MCP d'une app : `initialize`, puis requêtes, réponse
 * en JSON ou en flux SSE. Aucune dépendance : le Hub ne parle à une app que par le protocole.
 */

export type OutilApp = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  title?: string;
};

export class AppInjoignable extends Error {}

/** L'app vérifie l'identité du Hub mais n'a pas (encore) ce compte : `hub_user_unknown`. */
export class CompteAbsent extends AppInjoignable {}

type Fetch = typeof fetch;
const DELAI_MS = 15_000;
const VERSION = '2025-06-18';

async function lireReponse(res: Response, id: number): Promise<{ result?: unknown; error?: { message?: string } }> {
  const type = res.headers.get('content-type') ?? '';
  const texte = await res.text();
  if (type.includes('text/event-stream')) {
    for (const bloc of texte.split(/\r?\n\r?\n/)) {
      const data = bloc
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id === id) return msg;
      } catch {
        /* bloc non JSON : ignoré */
      }
    }
    throw new AppInjoignable('flux SSE sans réponse');
  }
  try {
    return JSON.parse(texte);
  } catch {
    throw new AppInjoignable(`réponse illisible (HTTP ${res.status})`);
  }
}

export class SessionApp {
  private session: string | null = null;
  private suivant = 1;

  constructor(
    private readonly url: string,
    private readonly jeton: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async envoyer(corps: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.jeton}`,
      'MCP-Protocol-Version': VERSION,
    };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    try {
      return await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(corps), signal: AbortSignal.timeout(DELAI_MS) });
    } catch (err) {
      throw new AppInjoignable(err instanceof Error ? err.message : 'réseau');
    }
  }

  async requete(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.suivant++;
    const res = await this.envoyer({ jsonrpc: '2.0', id, method, params });
    if (res.status === 401 || res.status === 403) {
      const corps = await res.text().catch(() => '');
      if (corps.includes('hub_user_unknown')) throw new CompteAbsent('compte absent dans l\'app');
      throw new AppInjoignable(`l'app refuse l'identité du Hub (HTTP ${res.status})`);
    }
    if (!res.ok) throw new AppInjoignable(`HTTP ${res.status}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const msg = await lireReponse(res, id);
    if (msg.error) throw new AppInjoignable(msg.error.message ?? 'erreur MCP');
    return msg.result;
  }

  async ouvrir(): Promise<void> {
    await this.requete('initialize', {
      protocolVersion: VERSION,
      capabilities: {},
      clientInfo: { name: 'veridian-hub', version: '1' },
    });
    // Notification : pas de réponse attendue.
    await this.envoyer({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
  }

  async outils(): Promise<OutilApp[]> {
    const tous: OutilApp[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.requete('tools/list', cursor ? { cursor } : {})) as { tools?: OutilApp[]; nextCursor?: string };
      tous.push(...(r.tools ?? []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tous;
  }

  appeler(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.requete('tools/call', { name, arguments: args });
  }
}
