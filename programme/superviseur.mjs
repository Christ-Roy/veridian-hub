/**
 * Superviseur des programmes : écoute une socket Unix, une connexion = un programme = un processus neuf dans la prison, sous
 * un uid réservé. Conteneur sans réseau (`network_mode = "none"`), sans secret. Il ne lit pas les messages : il transporte,
 * borne, et tue tout ce qui tourne sous l'uid à la fin. Un uid qu'il n'arrive pas à vider n'est plus attribué.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const SOCKET = process.env.PROGRAMME_SOCKET || '/alloc/data/programme/moteur.sock';
const PRISON = process.env.PROGRAMME_PRISON || '/opt/programme/prison';
/** Le chroot de coreutils (--userspec) : celui de busybox ne change pas d'utilisateur. Lien posé et vérifié à la construction. */
const CHROOT = process.env.PROGRAMME_CHROOT || '/opt/programme/chroot';
const ENTREE = process.env.PROGRAMME_ENTREE || '/app/executeur.mjs';
const PLACES = 4;
const UID_BASE = 20001;
/** Le Hub coupe à 45 s ; ceci n'est qu'un filet si le Hub disparaît. */
const VIE_MAX_MS = 55_000;
const SORTIE_MAX_OCTETS = 64 * 1024 * 1024;

const libres = new Set(Array.from({ length: PLACES }, (_, i) => UID_BASE + i));
const log = (o) => console.log(JSON.stringify({ tag: '[programme]', ...o, ts: new Date().toISOString() }));

export function processusDe(uid, proc = '/proc') {
  return readdirSync(proc).filter((d) => /^\d+$/.test(d)).filter((d) => {
    try {
      const s = readFileSync(`${proc}/${d}/status`, 'utf8');
      return new RegExp(`^Uid:.*\\b${uid}\\b`, 'm').test(s) && !/^State:\s+Z/m.test(s);
    } catch {
      return false;
    }
  }).map(Number);
}

async function vider(uid) {
  for (let i = 0; i < 20; i++) {
    const ps = processusDe(uid);
    if (!ps.length) return true;
    for (const p of ps) try { process.kill(p, 'SIGKILL'); } catch { /* déjà parti */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function servir(conn) {
  conn.on('error', () => conn.destroy());
  const uid = libres.values().next().value;
  if (uid === undefined) { conn.end('{"t":"occupe"}\n'); return; }
  libres.delete(uid);
  const debut = Date.now();
  const p = spawn(CHROOT, [`--userspec=${uid}:${uid}`, '--groups=', PRISON, '/node', '--max-old-space-size=96', ENTREE], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let sortie = 0;
  let raison = 'fin';
  const tuer = (r) => { if (raison === 'fin') raison = r; p.kill('SIGKILL'); };
  const minuteur = setTimeout(() => tuer('delai'), VIE_MAX_MS);
  p.stdin.on('error', () => undefined);
  p.stderr.resume();
  conn.pipe(p.stdin);
  p.stdout.on('data', (d) => { sortie += d.length; if (sortie > SORTIE_MAX_OCTETS) tuer('sortie_trop_grosse'); });
  p.stdout.pipe(conn);
  conn.on('close', () => tuer('connexion_fermee'));
  p.on('error', (e) => { log({ uid, erreur: e.code }); conn.destroy(); });
  p.on('close', async (code, signal) => {
    clearTimeout(minuteur);
    conn.end();
    const vide = await vider(uid);
    if (vide) libres.add(uid);
    log({ uid, ms: Date.now() - debut, code, signal, raison, sortie, vide, places: libres.size });
  });
}

export function demarrer() {
  mkdirSync(path.dirname(SOCKET), { recursive: true });
  if (existsSync(SOCKET)) unlinkSync(SOCKET);
  // Première ligne {"t":"sante"} : réponse de santé, sans lancer de programme.
  const serveur = net.createServer((conn) => {
    conn.once('data', (premier) => {
      if (premier.length < 64 && premier.toString().startsWith('{"t":"sante"}')) { conn.on('error', () => undefined); conn.end(`{"t":"sante","places":${libres.size}}\n`); return; }
      conn.pause();
      conn.unshift(premier);
      servir(conn);
      conn.resume();
    });
    conn.on('error', () => conn.destroy());
    conn.setTimeout(VIE_MAX_MS + 5_000, () => conn.destroy());
  });
  serveur.listen(SOCKET, () => { chmodSync(SOCKET, 0o666); log({ pret: true, places: libres.size }); });
  return serveur;
}

if (process.argv[1] && process.argv[1].endsWith('superviseur.mjs')) demarrer();
