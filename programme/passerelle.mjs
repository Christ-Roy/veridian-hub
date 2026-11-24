/**
 * Passerelle des programmes : la seule pièce qui a un réseau. Elle vérifie que l'appel vient du Hub (JWT ES256 lu dans
 * Authorization, clé publique du Hub, aucun secret ici), puis transporte les octets vers la socket du superviseur.
 */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const SOCKET = process.env.PROGRAMME_SOCKET || '/alloc/data/programme/moteur.sock';
const PORT = Number(process.env.PROGRAMME_PORT || 3200);
const EMETTEUR = process.env.PROGRAMME_EMETTEUR || 'https://app.veridian.site';
const HUB_URL_FICHIER = process.env.PROGRAMME_HUB_URL_FICHIER || '/local/hub-url';
export const AUDIENCE = 'hub-programme';
const VIE_JETON_S = 60;
const vus = new Map();
let cles = { a: 0, parKid: new Map() };

const b64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function lireCles(fetchImpl) {
  for (const base of readFileSync(HUB_URL_FICHIER, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const r = await fetchImpl(`${base}/.well-known/jwks.json`, { signal: AbortSignal.timeout(4_000) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (Array.isArray(j?.keys) && j.keys.length) return new Map(j.keys.filter((k) => k.kty === 'EC' && k.crv === 'P-256' && k.kid).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  }
  return null;
}

/** Rend l'identifiant du programme, ou null. Tout écart est un refus. */
export async function verifierJeton(entete, { maintenant = Date.now(), fetchImpl = fetch, emetteur = EMETTEUR } = {}) {
  try {
    const jeton = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(entete ?? '')?.[1];
    if (!jeton) return null;
    const [h, c, s] = jeton.split('.');
    const tete = b64(h);
    if (tete.alg !== 'ES256' || typeof tete.kid !== 'string') return null;
    if (!cles.parKid.has(tete.kid) && maintenant - cles.a > 5_000) {
      const lues = await lireCles(fetchImpl);
      cles = { a: maintenant, parKid: lues ?? cles.parKid };
    }
    const cle = cles.parKid.get(tete.kid);
    if (!cle || !verify('sha256', Buffer.from(`${h}.${c}`), { key: cle, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return null;
    const p = b64(c);
    const s0 = maintenant / 1000;
    if (p.iss !== emetteur || p.aud !== AUDIENCE || typeof p.jti !== 'string' || typeof p.sub !== 'string') return null;
    if (!(p.exp > s0 && p.exp <= s0 + VIE_JETON_S + 5 && p.iat <= s0 + 5)) return null;
    for (const [k, t] of vus) if (t < s0) vus.delete(k);
    if (vus.has(p.jti)) return null;
    vus.set(p.jti, p.exp);
    return p.sub;
  } catch {
    return null;
  }
}

export function oublier() { vus.clear(); cles = { a: 0, parKid: new Map() }; }

function sante(socket = SOCKET) {
  return new Promise((ok) => {
    const c = net.connect({ path: socket });
    const fin = (v) => { c.destroy(); ok(v); };
    c.setTimeout(2_000, () => fin(null));
    c.on('connect', () => c.write('{"t":"sante"}\n'));
    c.on('data', (d) => { try { fin(JSON.parse(d.toString())); } catch { fin(null); } });
    c.on('error', () => fin(null));
  });
}

export function demarrer(port = PORT, socket = SOCKET, options = {}) {
  const serveur = http.createServer(async (req, res) => {
    if (req.url !== '/sante') { res.writeHead(404).end(); return; }
    const s = await sante(socket);
    res.writeHead(s ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(s ?? { etat: 'moteur_muet' }));
  });
  serveur.on('upgrade', async (req, sock, tete) => {
    sock.on('error', () => sock.destroy());
    const refuser = (code, texte) => sock.end(`HTTP/1.1 ${code} ${texte}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.headers.upgrade !== 'programme') return refuser(400, 'Bad Request');
    const qui = await verifierJeton(req.headers.authorization, options);
    if (!qui) return refuser(401, 'Unauthorized');
    const m = net.connect({ path: socket });
    m.on('error', () => refuser(503, 'Service Unavailable'));
    m.on('connect', () => {
      m.removeAllListeners('error');
      m.on('error', () => sock.destroy());
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: programme\r\nConnection: Upgrade\r\n\r\n');
      if (tete.length) m.write(tete);
      sock.pipe(m);
      m.pipe(sock);
      sock.on('close', () => m.destroy());
    });
  });
  return serveur.listen(port);
}

if (process.argv[1] && process.argv[1].endsWith('passerelle.mjs')) demarrer();
