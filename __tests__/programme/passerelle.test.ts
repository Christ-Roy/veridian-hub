// @vitest-environment node
/** Passerelle des programmes : seul le Hub ouvre un programme (JWT ES256, clé publique), tout écart est refusé. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'passerelle-'));
process.env.PROGRAMME_HUB_URL_FICHIER = path.join(dir, 'hub-url');
writeFileSync(process.env.PROGRAMME_HUB_URL_FICHIER, 'http://hub.test\n');

type M = typeof import('../../programme/passerelle.mjs');
let m: M;
let cle: CryptoKey;
let autre: CryptoKey;
let jwks: unknown;
const EMETTEUR = 'https://app.veridian.site';
const fetchImpl = vi.fn(async () => Response.json(jwks)) as unknown as typeof fetch;
const jeton = (o: { cle?: CryptoKey; iss?: string; aud?: string; exp?: number; kid?: string; jti?: string | null; alg?: string } = {}) => {
  const s = Math.floor(Date.now() / 1000);
  const j = new SignJWT({}).setProtectedHeader({ alg: o.alg ?? 'ES256', kid: o.kid ?? 'k1' }).setIssuer(o.iss ?? EMETTEUR).setAudience(o.aud ?? 'hub-programme').setSubject('p1').setIssuedAt(s).setExpirationTime(o.exp ?? s + 30);
  if (o.jti !== null) j.setJti(o.jti ?? Math.random().toString(36));
  return j.sign(o.cle ?? cle).then((t) => `Bearer ${t}`);
};
const opt = { fetchImpl, emetteur: EMETTEUR };

beforeAll(async () => {
  m = (await import('../../programme/passerelle.mjs')) as M;
  const a = await generateKeyPair('ES256', { extractable: true });
  cle = a.privateKey as CryptoKey;
  autre = (await generateKeyPair('ES256', { extractable: true })).privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(a.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] };
});
beforeEach(() => m.oublier());

describe('verifierJeton', () => {
  it('le jeton du Hub passe, une fois', async () => {
    const t = await jeton();
    expect(await m.verifierJeton(t, opt)).toBe('p1');
    expect(await m.verifierJeton(t, opt), 'rejeu').toBeNull();
  });

  it('tout écart est refusé', async () => {
    const s = Math.floor(Date.now() / 1000);
    const cas: [string, string | undefined][] = [
      ['absent', undefined], ['vide', ''], ['pas un jeton', 'Bearer x'], ['autre clé', await jeton({ cle: autre })], ['kid inconnu', await jeton({ kid: 'k2' })],
      ['émetteur', await jeton({ iss: 'https://evil.example' })], ['audience d\'une app', await jeton({ aud: 'https://crm.app.veridian.site/mcp' })],
      ['expiré', await jeton({ exp: s - 1 })], ['trop long', await jeton({ exp: s + 3600 })], ['sans jti', await jeton({ jti: null })],
    ];
    const bon = (await jeton()).split('.');
    cas.push(['corps changé', `${bon[0]}.${Buffer.from(JSON.stringify({ iss: EMETTEUR, aud: 'hub-programme', sub: 'x', jti: 'y', iat: s, exp: s + 30 })).toString('base64url')}.${bon[2]}`]);
    cas.push(['alg none', `Bearer ${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${bon[1]}.${bon[2]}`]);
    for (const [nom, t] of cas) {
      m.oublier();
      expect(await m.verifierJeton(t, opt), nom).toBeNull();
    }
  });

  it('Hub muet : refus, jamais une ouverture', async () => {
    expect(await m.verifierJeton(await jeton(), { ...opt, fetchImpl: vi.fn(async () => new Response('', { status: 502 })) as never })).toBeNull();
  });
});

describe('transport', () => {
  let serveur: http.Server;
  let moteur: net.Server;
  let port: number;
  const socket = path.join(dir, 'moteur.sock');
  let lances = 0;
  beforeAll(async () => {
    moteur = net.createServer((c) => { c.on('error', () => undefined); c.once('data', (d) => { if (d.toString().startsWith('{"t":"sante"}')) { c.end('{"t":"sante","places":4}\n'); return; } lances += 1; c.end(`recu ${d}`); }); });
    await new Promise<void>((r) => { moteur.listen(socket, r); });
    serveur = m.demarrer(0, socket, opt) as http.Server;
    await new Promise<void>((r) => { if (serveur.listening) r(); else serveur.once('listening', () => r()); });
    port = (serveur.address() as net.AddressInfo).port;
  });
  afterAll(() => { serveur.close(); moteur.close(); });
  const ouvrir = (authorization?: string) => new Promise<string>((r) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/programme', headers: { Connection: 'Upgrade', Upgrade: 'programme', ...(authorization ? { authorization } : {}) } });
    q.on('upgrade', (_res, s) => { let t = ''; s.on('data', (d) => { t += d; }); s.on('close', () => r(t)); s.write('bonjour\n'); });
    q.on('response', (res) => r(`HTTP ${res.statusCode}`));
    q.on('error', (e) => r(e.message));
    q.end();
  });

  it('sans jeton : 401, le superviseur n\'est pas joint ; avec : les octets passent dans les deux sens', async () => {
    expect(await ouvrir()).toBe('HTTP 401');
    expect(lances).toBe(0);
    expect(await ouvrir(await jeton())).toBe('recu bonjour\n');
    expect(lances).toBe(1);
  });

  it('/sante dit si le superviseur répond ; le reste n\'existe pas', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/sante`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/programme`)).status).toBe(404);
    const muet = m.demarrer(0, path.join(dir, 'absente.sock'), opt) as http.Server;
    await new Promise<void>((r) => { if (muet.listening) r(); else muet.once('listening', () => r()); });
    expect((await fetch(`http://127.0.0.1:${(muet.address() as net.AddressInfo).port}/sante`)).status).toBe(503);
    muet.close();
  });
});
