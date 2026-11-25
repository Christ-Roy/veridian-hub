/**
 * Fournisseur OIDC JETABLE (VER-227 S2) : vit dans le processus qui l'ouvre, meurt avec lui. Découverte, code avec PKCE, jeton signé ES256. La
 * prochaine identité se choisit (`dire`), et chaque mensonge se commande (`mentir`) pour voir le Hub le refuser. Sert aux tests et à la batterie.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';

export type IdentiteDite = { sub: string; email?: string; email_verified?: boolean; name?: string };
export type Mensonge = null | 'nonce' | 'audience' | 'emetteur' | 'signature' | 'expire' | 'pkce_ignore';
const b64 = (x: unknown) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const signer = (cle: KeyObject, kid: string, claims: object, alg: 'ES256' | 'RS256' = 'ES256') => {
  const corps = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`;
  return `${corps}.${sign('sha256', Buffer.from(corps), alg === 'RS256' ? cle : { key: cle, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};

/** `RS256` : réglé comme Infomaniak (RS256 seul). */
export async function ouvrirIdp(hote = '127.0.0.1', alg: 'ES256' | 'RS256' = 'ES256') {
  const paire = () => (alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' }));
  const { privateKey, publicKey } = paire();
  const autre = paire().privateKey;
  let portee = '';
  const client = { id: 'hub-epreuve', secret: randomBytes(24).toString('base64url') };
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string; qui: IdentiteDite }>();
  let qui: IdentiteDite = { sub: 'personne' };
  let mensonge: Mensonge = null;
  let base = '';
  let appels = 0;
  const serveur = createServer((req, res) => {
    const u = new URL(req.url ?? '/', base);
    const json = (x: unknown, statut = 200) => { res.writeHead(statut, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(x)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: [alg], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
    }
    if (u.pathname === '/jwks') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg, use: 'sig' }] });
    if (u.pathname === '/authorize') {
      appels += 1;
      portee = u.searchParams.get('scope') ?? '';
      const p = (n: string) => u.searchParams.get(n) ?? '';
      if (p('client_id') !== client.id || p('code_challenge_method') !== 'S256' || !p('nonce') || !p('state')) return json({ error: 'invalid_request' }, 400);
      const code = randomBytes(16).toString('base64url');
      codes.set(code, { nonce: p('nonce'), challenge: p('code_challenge'), redirect: p('redirect_uri'), qui });
      const retour = new URL(p('redirect_uri'));
      retour.searchParams.set('code', code);
      retour.searchParams.set('state', p('state'));
      res.writeHead(302, { location: retour.href });
      return res.end();
    }
    if (u.pathname === '/token') {
      let corps = '';
      req.on('data', (d) => { corps += d; });
      req.on('end', () => {
        const f = new URLSearchParams(corps);
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const pkce = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (!c || f.get('client_id') !== client.id || f.get('client_secret') !== client.secret || c.redirect !== f.get('redirect_uri') || (mensonge !== 'pkce_ignore' && c.challenge !== pkce)) return json({ error: 'invalid_grant' }, 400);
        const s = Math.floor(Date.now() / 1000);
        const claims = {
          iss: mensonge === 'emetteur' ? 'https://pirate.test' : base,
          aud: mensonge === 'audience' ? 'autre-client' : client.id,
          nonce: mensonge === 'nonce' ? 'un-autre-nonce' : c.nonce,
          iat: mensonge === 'expire' ? s - 7200 : s,
          exp: mensonge === 'expire' ? s - 3600 : s + 300,
          ...c.qui,
        };
        json({ access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: signer(mensonge === 'signature' ? autre : privateKey, 'k1', claims, alg) });
      });
      return;
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise<void>((ok, ko) => { serveur.once('error', ko); serveur.listen(0, hote, ok); });
  base = `http://${hote}:${(serveur.address() as { port: number }).port}`;
  return {
    issuer: base,
    client,
    dire: (x: IdentiteDite) => { qui = x; },
    mentir: (x: Mensonge) => { mensonge = x; },
    demandes: () => appels,
    /** La dernière portée demandée. */
    portee: () => portee,
    fermer: () => new Promise<void>((ok) => { serveur.closeAllConnections(); serveur.close(() => ok()); }),
  };
}
