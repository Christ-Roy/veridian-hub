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

export class AppInjoignable extends Error {
  /** Code de refus rendu par l'app (`CODES_REFUS`), quand elle en donne un. */
  constructor(message?: string, readonly code?: string, /** Statut HTTP de la réponse, quand c'est lui qui refuse. */ readonly statut?: number) {
    super(message);
  }
}

/** Le message vient du serveur MCP lui-même : le texte d'un tiers, pas le nôtre. */
export class AppErreurMcp extends AppInjoignable {}
/** Le message vient du réseau : il peut citer ce que le serveur présente (certificat, hôte). */
export class AppReseau extends AppInjoignable {}

/** Refus avant l'outil, que le Hub sait nommer (CRM, 25/11). Cherchés dans le corps : sa forme dépend de l'app. */
const CODES_REFUS = /\b(app_not_available|app_uninstalled|app_installing|app_install_failed|tenant_not_linked|tenant_forbidden|workspace_inactive)\b/;

/** L'app limite le débit (429) : rien n'a été joué, l'appel peut être refait après ce délai. */
export class AppDebit extends AppInjoignable {
  constructor(readonly attenteMs: number) {
    super('HTTP 429, trop de requêtes pour cette app');
  }
}

/** L'app vérifie l'identité du Hub mais n'a pas (encore) ce compte : `hub_user_unknown`. */
export class CompteAbsent extends AppInjoignable {}

type Fetch = typeof fetch;
const DELAI_MS = 15_000;
/** Un outil peut travailler longtemps (install_app du CRM : plus de 15 s à froid, 24/11). Sous les 100 s de Cloudflare. */
const DELAI_OUTIL_MS = 60_000;
const VERSION = '2025-06-18';

/** Corps d'une réponse, jamais plus de `max` octets en mémoire. */
async function lireTexte(res: Response, max?: number): Promise<string> {
  if (!max || !res.body) return res.text();
  const lecteur = res.body.getReader();
  const morceaux: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await lecteur.cancel().catch(() => {});
      throw new AppInjoignable(`réponse de plus de ${max} octets : demander moins de lignes ou moins de colonnes`);
    }
    morceaux.push(value);
  }
  return Buffer.concat(morceaux).toString('utf8');
}

async function lireReponse(res: Response, id: number, max?: number): Promise<{ result?: unknown; error?: { message?: string } }> {
  const type = res.headers.get('content-type') ?? '';
  const texte = await lireTexte(res, max);
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
    /** Mode programme : en-tête annoncé à l'app, taille de réponse bornée, abandon à l'échéance. */
    private readonly options: { entetes?: Record<string, string>; maxOctets?: number; signal?: AbortSignal } = {},
  ) {}

  private async envoyer(corps: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.jeton}`,
      'MCP-Protocol-Version': VERSION,
      ...this.options.entetes,
    };
    const outil = corps.method === 'tools/call';
    const delai = AbortSignal.timeout(outil ? DELAI_OUTIL_MS : DELAI_MS);
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    try {
      return await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(corps), signal: this.options.signal ? AbortSignal.any([delai, this.options.signal]) : delai });
    } catch (err) {
      // Coupé de notre côté : l'app a peut-être fini le travail. Le dire, sans quoi l'IA rejoue une écriture déjà faite.
      if (outil && delai.aborted) throw new AppInjoignable(`pas de réponse en ${DELAI_OUTIL_MS / 1000} s : l'action a peut-être eu lieu, le vérifier avant de rejouer`);
      throw new AppReseau(err instanceof Error ? err.message : 'réseau');
    }
  }

  async requete(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.suivant++;
    const res = await this.envoyer({ jsonrpc: '2.0', id, method, params });
    if (res.status === 401 || res.status === 403) {
      const corps = await res.text().catch(() => '');
      if (corps.includes('hub_user_unknown')) throw new CompteAbsent('compte absent dans l\'app', undefined, res.status);
      // Règle tenant_id du contrat : l'espace choisi n'est pas relié chez l'app, ou l'utilisateur n'en est pas membre.
      if (corps.includes('tenant_not_linked')) throw new AppInjoignable('cet espace n\'est pas relié dans l\'app (tenant_not_linked)', 'tenant_not_linked', res.status);
      if (corps.includes('tenant_forbidden')) throw new AppInjoignable('ce compte n\'est pas membre de cet espace dans l\'app (tenant_forbidden)', 'tenant_forbidden', res.status);
      const code = CODES_REFUS.exec(corps)?.[1];
      throw new AppInjoignable(code ? `l'app refuse (HTTP ${res.status}, ${code})` : `l'app refuse l'identité du Hub (HTTP ${res.status})`, code, res.status);
    }
    if (res.status === 429) {
      const s = Number(res.headers.get('retry-after'));
      throw new AppDebit(Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 60_000) : 2_000);
    }
    if (!res.ok) {
      const code = CODES_REFUS.exec((await res.text().catch(() => '')).slice(0, 4_000))?.[1];
      throw new AppInjoignable(code ? `HTTP ${res.status}, ${code}` : `HTTP ${res.status}`, code, res.status);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    const msg = await lireReponse(res, id, this.options.maxOctets).catch((err) => {
      throw err instanceof AppInjoignable ? err : new AppReseau(err instanceof Error ? err.message : 'réseau');
    });
    if (msg.error) throw new AppErreurMcp(msg.error.message ?? 'erreur MCP');
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

/** Ce que la porte attend d'une session, d'app ou de service extérieur. */
export type SessionOutils = Pick<SessionApp, 'outils' | 'appeler'>;
