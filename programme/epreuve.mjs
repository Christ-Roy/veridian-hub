// Exécuteur VOLONTAIREMENT COMPROMIS (scripts/epreuve-programme.sh) : du code arbitraire à la place du bac à sable. Il dit ce
// qu'il a pu obtenir, jamais la valeur. Le même code tourne dans la prison et, comme témoin, dans le conteneur du Hub.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import cp from 'node:child_process';
import os from 'node:os';

const R = {};
// Troisième argument : ne jouer que ces attaques (second témoin, dans le conteneur du moteur).
const seules = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const essai = (n, f) => { if (seules && !seules.has(n)) return; try { R[n] = f() ? 1 : 0; } catch { R[n] = 0; } };
const connecte = (n, o) => new Promise((ok) => { if (seules && !seules.has(n)) return ok(); const s = net.connect(o); const fin = (v) => { R[n] = v; s.destroy(); ok(); }; s.setTimeout(2500, () => fin(0)); s.on('connect', () => fin(1)); s.on('error', () => fin(0)); });
const base = (() => { try { return new URL(process.env.DATABASE_URL); } catch { return null; } })();

essai('secret:env AUTH_SECRET', () => process.env.AUTH_SECRET);
essai('secret:une variable d\'environnement', () => Object.keys(process.env).length);
essai('secret:/proc/self/environ', () => fs.readFileSync('/proc/self/environ').length);
essai('secret:/proc/1/environ', () => fs.readFileSync('/proc/1/environ').length);
essai('secret:/secrets', () => fs.readdirSync('/secrets').length);
essai('secret:socket de Nomad', () => fs.statSync('/secrets/api.sock').isSocket());
essai('disque:/alloc', () => fs.readdirSync('/alloc').length);
essai('disque:/etc/passwd', () => fs.readFileSync('/etc/passwd').length);
essai('disque:/proc', () => fs.readdirSync('/proc').length);
essai('disque:/dev', () => fs.readdirSync('/dev').length);
essai('disque:hors de la racine', () => { const l = fs.readdirSync('/../..'); return l.includes('proc') || l.includes('etc'); });
// Nom propre à ce processus : un essai raté peut laisser un fichier vide d'un autre uid.
for (const f of ['/tmp/x', '/alloc/data/x']) essai(`disque:ecrire ${f}`, () => { const g = f + process.pid; fs.writeFileSync(g, 'x'); fs.unlinkSync(g); return 1; });
essai('systeme:shell', () => cp.execFileSync('/bin/sh', ['-c', 'echo 1']).length);
essai('systeme:redevenir root', () => { process.setuid(0); return process.getuid() === 0; });
essai('systeme:interfaces reseau', () => Object.keys(os.networkInterfaces()).some((i) => i !== 'lo'));
// Tout ce qui a démarré avant lui (superviseur, programme voisin et leurs fils) : kill() accepte aussi ses PROPRES fils
// d'exécution, numérotés après lui, qui ne prouvent rien.
essai('voisins:un processus plus ancien', () => { for (let p = 1; p < process.pid; p++) if (p !== process.ppid) try { process.kill(p, 0); return 1; } catch { /* refus */ } return 0; });
essai('voisins:le programme d\'un autre compte', () => { process.kill(Number(process.argv[2]), 0); return 1; });
await connecte('reseau:internet', { host: '1.1.1.1', port: 443 });
await connecte('reseau:base du Hub', { host: base?.hostname || '172.26.64.1', port: Number(base?.port || 5432) });
await connecte('reseau:Hub en boucle locale', { host: '127.0.0.1', port: 3000 });
await connecte('reseau:socket du superviseur', { path: '/alloc/data/programme/moteur.sock' });
if (!seules) R['reseau:dns'] = await dns.resolve4('one.one.one.one').then(() => 1, () => 0);
console.log(JSON.stringify(R));
