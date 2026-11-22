// Proxy de sortie de l'atelier « Mon IA » (docs/MON-IA.md), tâche voisine du groupe `atelier` : le binaire
// Claude Code passe par lui (HTTPS_PROXY), et il ne laisse ouvrir un tunnel que vers Anthropic. Tout le reste,
// tailnet et réseau interne compris, est refusé et journalisé. Pas d'image tierce : même image que le Hub.
import http from 'node:http';
import net from 'node:net';

import { hoteAutorise } from './regles.mjs';

const PORT = Number(process.env.ATELIER_PROXY_PORT || 3128);
const journal = (o) => console.log(JSON.stringify({ tag: '[atelier-proxy]', ts: new Date().toISOString(), ...o }));

const serveur = http.createServer((req, res) => {
  // Aucun HTTP en clair : le binaire ne parle qu'en HTTPS (CONNECT).
  journal({ evt: 'refus', methode: req.method, hote: req.headers.host ?? null });
  res.writeHead(403);
  res.end();
});

serveur.on('connect', (req, client, tete) => {
  const [hote, portBrut] = String(req.url ?? '').split(':');
  const port = Number(portBrut || 443);
  if (!hoteAutorise(hote) || port !== 443) {
    journal({ evt: 'refus', hote, port });
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const amont = net.connect(port, hote, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (tete?.length) amont.write(tete);
    amont.pipe(client);
    client.pipe(amont);
  });
  const fermer = () => {
    amont.destroy();
    client.destroy();
  };
  amont.on('error', fermer);
  client.on('error', fermer);
});

serveur.listen(PORT, '127.0.0.1', () => journal({ evt: 'pret', port: PORT }));
