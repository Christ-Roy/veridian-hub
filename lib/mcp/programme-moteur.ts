/** Le Hub vers la passerelle des programmes : une connexion HTTP élevée (`Upgrade: programme`), des lignes JSON. */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';

import { signerPourProgramme } from './identite';
import type { Moteur, OuvrirMoteur } from './programme';

const OUVERTURE_MS = 5_000;
/** Un exécuteur qui demande sans lire ne remplit pas la mémoire du Hub. */
const NON_LU_MAX_OCTETS = 8_000_000;

export const programmeConfigure = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.PROGRAMME_FICHIER);

function adresses(env: NodeJS.ProcessEnv): string[] {
  try {
    return readFileSync(env.PROGRAMME_FICHIER ?? '', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function ouvrir(base: string, jeton: string): Promise<Duplex> {
  return new Promise((ok, non) => {
    const req = http.request(`${base}/programme`, { headers: { Connection: 'Upgrade', Upgrade: 'programme', Authorization: `Bearer ${jeton}` } });
    const minuteur = setTimeout(() => req.destroy(new Error('délai')), OUVERTURE_MS);
    req.on('upgrade', (_res, socket, tete) => {
      clearTimeout(minuteur);
      if (tete.length) socket.unshift(tete);
      ok(socket);
    });
    req.on('response', (res) => {
      clearTimeout(minuteur);
      res.resume();
      non(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('error', (e) => {
      clearTimeout(minuteur);
      non(e);
    });
    req.end();
  });
}

/** Découpe un flux en lignes, sans jamais garder plus de `max` octets d'une ligne. */
export function enMoteur(flux: Duplex, max: number): Moteur {
  let reste = '';
  let surLigne: (l: string) => void = () => {};
  let surFin: () => void = () => {};
  let ferme = false;
  const fermer = () => {
    if (ferme) return;
    ferme = true;
    flux.destroy();
    surFin();
  };
  flux.setEncoding('utf8');
  flux.on('data', (d: string) => {
    if (ferme) return;
    reste += d;
    for (let i = reste.indexOf('\n'); i >= 0 && !ferme; i = reste.indexOf('\n')) {
      const l = reste.slice(0, i);
      reste = reste.slice(i + 1);
      surLigne(l);
    }
    if (reste.length > max) fermer();
  });
  flux.on('error', fermer);
  flux.on('close', fermer);
  flux.on('end', fermer);
  return {
    envoyer: (m) => {
      if (ferme) return;
      flux.write(`${JSON.stringify(m)}\n`);
      if (flux.writableLength > NON_LU_MAX_OCTETS) fermer();
    },
    surLigne: (f) => {
      surLigne = f;
    },
    surFin: (f) => {
      surFin = f;
    },
    fermer,
  };
}

export const ouvrirMoteur: OuvrirMoteur = async (programme, max) => {
  for (const base of adresses(process.env)) {
    try {
      return enMoteur(await ouvrir(base, await signerPourProgramme(programme)), max);
    } catch (err) {
      console.error('[mcp][programme] moteur injoignable', err instanceof Error ? err.message : 'erreur');
    }
  }
  return null;
};
