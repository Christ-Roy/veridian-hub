/**
 * Service extérieur JETABLE (VER-119) : serveur MCP protégé par OAuth, enregistrement automatique du client, PKCE, rotation du jeton de renouvellement,
 * révocation. Chaque mensonge se commande (`mentir`). Vit dans le processus qui l'ouvre ; sert aux tests.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export type MensongeService = null | 'sans_enregistrement' | 'state' | 'jeton_refuse' | 'refresh_refuse' | 'panne' | 'sans_refresh' | 'secret_exige';

export async function ouvrirService() {
  let mensonge: MensongeService = null;
  let base = '';
  const clients = new Map<string, { retours: string[]; secret: string | null }>();
  const codes = new Map<string, { client: string; challenge: string; retour: string; resource: string }>();
  const acces = new Set<string>();
  const refreshs = new Set<string>();
  const vu = { enregistrements: 0, renouvellements: 0, revocations: 0, appels: [] as string[], jetonsVus: [] as string[], entetes: {} as Record<string, unknown> };
  const neuf = () => randomBytes(16).toString('hex');
  const donner = () => {
    const a = neuf();
    const r = neuf();
    acces.add(a);
    refreshs.add(r);
    return { access_token: a, token_type: 'Bearer', expires_in: 3600, ...(mensonge === 'sans_refresh' ? {} : { refresh_token: r }) };
  };
  const serveur = createServer((req, res) => {
    const u = new URL(req.url ?? '/', base);
    const json = (x: unknown, statut = 200) => { res.writeHead(statut, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, revocation_endpoint: `${base}/revoke`, ...(mensonge === 'sans_enregistrement' ? {} : { registration_endpoint: `${base}/register` }), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: mensonge === 'secret_exige' ? ['client_secret_post'] : ['none', 'client_secret_post'] });
    }
    let corps = '';
    req.on('data', (d) => { corps += d; });
    req.on('end', () => {
      const f = new URLSearchParams(corps);
      if (u.pathname === '/register') {
        vu.enregistrements += 1;
        const d = JSON.parse(corps) as { redirect_uris: string[]; token_endpoint_auth_method: string };
        const id = neuf();
        const secret = d.token_endpoint_auth_method === 'none' ? null : neuf();
        clients.set(id, { retours: d.redirect_uris, secret });
        return json({ client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), redirect_uris: d.redirect_uris, token_endpoint_auth_method: d.token_endpoint_auth_method }, 201);
      }
      if (u.pathname === '/authorize') {
        const p = (n: string) => u.searchParams.get(n) ?? '';
        const c = clients.get(p('client_id'));
        if (!c?.retours.includes(p('redirect_uri')) || p('code_challenge_method') !== 'S256') return json({ error: 'invalid_request' }, 400);
        const code = neuf();
        codes.set(code, { client: p('client_id'), challenge: p('code_challenge'), retour: p('redirect_uri'), resource: p('resource') });
        const r = new URL(p('redirect_uri'));
        r.searchParams.set('code', code);
        r.searchParams.set('state', mensonge === 'state' ? 'un-autre' : p('state'));
        res.writeHead(302, { location: r.href });
        return res.end();
      }
      if (u.pathname === '/token') {
        if (mensonge === 'panne') { res.writeHead(503); return res.end(); }
        const c = clients.get(f.get('client_id') ?? '');
        if (!c || (c.secret && c.secret !== f.get('client_secret')) || f.get('resource') !== `${base}/mcp`) return json({ error: 'invalid_client' }, 401);
        if (f.get('grant_type') === 'refresh_token') {
          vu.renouvellements += 1;
          const r = f.get('refresh_token') ?? '';
          if (mensonge === 'refresh_refuse' || !refreshs.delete(r)) return json({ error: 'invalid_grant' }, 400);
          return json(donner());
        }
        const k = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const pkce = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        return k && k.challenge === pkce && k.client === f.get('client_id') && k.retour === f.get('redirect_uri') ? json(donner()) : json({ error: 'invalid_grant' }, 400);
      }
      if (u.pathname === '/revoke') { vu.revocations += 1; acces.delete(f.get('token') ?? ''); refreshs.delete(f.get('token') ?? ''); return json({}); }
      if (u.pathname === '/mcp') {
        const jeton = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        vu.jetonsVus.push(jeton);
        vu.entetes = req.headers;
        if (mensonge === 'jeton_refuse' || !acces.has(jeton)) return json({ error: 'invalid_token' }, 401);
        const m = JSON.parse(corps) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
        vu.appels.push(m.method);
        if (m.id === undefined) { res.writeHead(202); return res.end(); }
        if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jetable', version: '1' } } });
        if (m.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'chercher', description: 'Cherche une page', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } });
        return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `trouvé ${JSON.stringify(m.params?.arguments)}` }] } });
      }
      return json({ error: 'not_found' }, 404);
    });
  });
  await new Promise<void>((ok, ko) => { serveur.once('error', ko); serveur.listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${(serveur.address() as { port: number }).port}`;
  return {
    base,
    mcpUrl: `${base}/mcp`,
    vu,
    mentir: (x: MensongeService) => { mensonge = x; },
    perimer: () => acces.clear(),
    fermer: () => new Promise<void>((ok) => { serveur.closeAllConnections(); serveur.close(() => ok()); }),
  };
}
