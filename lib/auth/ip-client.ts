/**
 * IP de l'appelant, non choisie par lui (23/11).
 *
 * Seul X-Forwarded-For est lu, par la fin, parce que Traefik l'écrit : il retire les en-têtes d'un pair hors de ses
 * `trustedIPs` (Cloudflare et réseaux privés, jobs/infra/ingress*.nomad.hcl), puis ajoute TOUJOURS l'adresse du pair TCP.
 *   - pair public et seul : appelant direct, c'est lui ;
 *   - pair public précédé d'un élément : Traefik lui fait confiance, donc un bord Cloudflare, qui a ajouté l'adresse du
 *     visiteur juste avant (tout ce qui est plus à gauche vient du visiteur) ;
 *   - pair en boucle locale : cloudflared sur l'ingress, même lecture ;
 *   - pair privé (parc, tailnet) : lui-même, jamais ce qu'il annonce.
 * `cf-connecting-ip` et `x-real-ip` ne sont plus lus : Traefik ne les retire pas d'un appelant direct.
 * Pas de liste Cloudflare ici : une seule source, les `trustedIPs` de l'ingress.
 */
import { isIP } from 'node:net';

function canonique(brut: string | undefined): string | null {
  const ip = (brut ?? '').trim().replace(/^::ffff:(?=\d+\.)/i, '').toLowerCase();
  return isIP(ip) ? ip : null;
}

export function estBoucle(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.');
}

/** Réseaux privés du parc : RFC1918, CGNAT (tailnet), ULA et lien local IPv6. */
export function estPrivee(ip: string): boolean {
  if (isIP(ip) === 6) return /^(f[cd]|fe[89ab])/.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

export type VueIp = { ip: string | null; source: 'pair' | 'avant-pair' | 'aucune'; elements: number };

export function vueIp(headers: Headers): VueIp {
  const xff = (headers.get('x-forwarded-for') ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  const pair = canonique(xff[xff.length - 1]);
  if (!pair) return { ip: null, source: 'aucune', elements: xff.length };
  const avant = canonique(xff[xff.length - 2]);
  if (avant && (estBoucle(pair) || !estPrivee(pair))) return { ip: avant, source: 'avant-pair', elements: xff.length };
  return { ip: pair, source: 'pair', elements: xff.length };
}

/** L'adresse exacte, pour la mesure d'audience et les journaux. */
export const ipClient = (headers: Headers): string => vueIp(headers).ip ?? 'unknown';

/** Les quatre premiers groupes d'une IPv6 : un abonné reçoit au moins un /64, donc 2^64 adresses à sa main. */
function prefixe64(ip: string): string {
  const [g, d] = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a, b, c, e) => `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +e).toString(16)}`).split('::');
  const gauche = g ? g.split(':') : [];
  const droite = d ? d.split(':') : [];
  const tout = d === undefined ? gauche : [...gauche, ...Array<string>(Math.max(0, 8 - gauche.length - droite.length)).fill('0'), ...droite];
  return `${tout.slice(0, 4).map((x) => (Number.parseInt(x, 16) || 0).toString(16)).join(':')}::/64`;
}

/** La clé d'un limiteur : l'IPv4, ou le /64 d'une IPv6. */
export function cleIp(headers: Headers): string {
  const ip = ipClient(headers);
  return isIP(ip) === 6 ? prefixe64(ip) : ip;
}
