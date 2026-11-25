/**
 * Sortie vers le fournisseur d'un client : l'adresse est vérifiée au moment où la connexion s'ouvre, sur l'IP réellement jointe. Vérifier le nom ne
 * suffit pas depuis qu'un propriétaire écrit l'adresse lui-même : un nom public peut désigner nos réseaux. HTTPS seul, aucune redirection, 1 Mo, 10 s.
 */
import { lookup } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { estPrivee } from '@/lib/auth/ip-client';

const MAX = 1_000_000;
const DELAI_MS = 10_000;

/** Ni nos réseaux, ni la machine, ni une adresse qui ne désigne personne. */
export function adressePublique(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return false;
  if (v === 6) {
    const x = ip.toLowerCase();
    const quatre = x.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (quatre) return adressePublique(quatre);
    // Seul l'unicast global ; jamais un tunnel qui transporte une IPv4 (6to4, NAT64, Teredo).
    return /^[23]/.test(x) && !/^(2002:|2001:0{0,4}:|2001::)/.test(x) && !estPrivee(x);
  }
  const [a, b] = ip.split('.').map(Number);
  return !estPrivee(ip) && a !== 0 && a !== 127 && a < 224 && !(a === 192 && b === 0) && !(a === 198 && (b === 18 || b === 19));
}

export const resoudrePublique: LookupFunction = (hote, o, cb) => {
  lookup(hote, { ...o, all: true }, (err, liste) => {
    if (err) return cb(err, '', 0);
    const l = liste as { address: string; family: number }[];
    if (l.length === 0 || !l.every((x) => adressePublique(x.address))) return cb(Object.assign(new Error('adresse_privee'), { code: 'EADRESSEPRIVEE' }), '', 0);
    return (o as { all?: boolean }).all ? (cb as unknown as (e: null, x: typeof l) => void)(null, l) : cb(null, l[0].address, l[0].family);
  });
};

/** Un `fetch` borné, pour `openid-client`. */
export async function fetchGarde(url: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || (isIP(u.hostname) && !adressePublique(u.hostname))) throw new Error('adresse_privee');
  const corps = o.body === undefined || o.body === null ? undefined : String(o.body);
  return new Promise((ok, ko) => {
    const r = request(u, { method: o.method ?? 'GET', headers: o.headers, lookup: resoudrePublique, timeout: DELAI_MS, signal: o.signal }, (res) => {
      const bouts: Buffer[] = [];
      let taille = 0;
      res.on('data', (d: Buffer) => {
        taille += d.length;
        if (taille > MAX) return r.destroy(new Error('reponse_trop_grosse'));
        bouts.push(d);
      });
      res.on('end', () => {
        const s = res.statusCode ?? 502;
        const entetes = Object.entries(res.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v] as [string, string]]));
        ok(new Response(s === 204 || s === 304 ? null : Buffer.concat(bouts), { status: s < 200 ? 502 : s, headers: entetes }));
      });
      res.on('error', ko);
    });
    r.on('timeout', () => r.destroy(new Error('delai')));
    r.on('error', ko);
    r.end(corps);
  });
}
