/**
 * Toute requête vers un service extérieur part d'ici : hôtes figés du registre, HTTPS, IP réellement jointe publique (`fetchGarde`), aucune redirection,
 * taille et durée TOTALE bornées (`fetchGarde` ne borne que le silence : une réponse au goutte à goutte tiendrait sans fin).
 */
import { fetchGarde } from '@/lib/federation/sortie';

import type { Connecteur } from './registre';

export type Deps = { fetchImpl?: typeof fetchGarde; /** Épreuve : service jetable en clair. Jamais en service. */ enClair?: boolean; now?: number; delaiMs?: number; /** Épreuve : pas de l'attente d'un renouvellement mené ailleurs. */ attenteMs?: number };

export const OAUTH_MAX_OCTETS = 200_000;
export const MCP_MAX_OCTETS = 1_000_000;
const OAUTH_DELAI_MS = 10_000;
/** Au-dessus des 60 s d'un appel d'outil : c'est `SessionApp` qui coupe le premier, et dit que l'action a peut-être eu lieu. */
const MCP_DELAI_MS = 65_000;

export class SortieRefusee extends Error {}

/** L'adresse est-elle chez un de ces hôtes, sans identifiants, en HTTPS ? */
export function tenirAdresse(adresse: string, hotes: readonly string[], d: Deps = {}): URL {
  const u = new URL(adresse);
  if ((u.protocol !== 'https:' && !d.enClair) || u.username || u.password) throw new SortieRefusee('adresse_refusee');
  if (!hotes.includes(u.host)) throw new SortieRefusee('hote_inattendu');
  return u;
}

type Options = { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal };
async function partir(u: URL, o: Options, b: { max: number; delaiMs: number }, d: Deps): Promise<Response> {
  const delai = AbortSignal.timeout(d.delaiMs ?? b.delaiMs);
  const signal = o.signal ? AbortSignal.any([o.signal, delai]) : delai;
  const res = await (d.fetchImpl ?? fetchGarde)(u.href, { ...o, redirect: 'manual', signal } as never);
  if (res.status >= 300 && res.status < 400) throw new SortieRefusee('redirection');
  const bouts: Uint8Array[] = [];
  let taille = 0;
  const lecteur = res.body?.getReader();
  for (let x = await lecteur?.read(); x && !x.done; x = await lecteur!.read()) {
    taille += x.value.byteLength;
    if (taille > b.max) {
      await lecteur!.cancel().catch(() => {});
      throw new SortieRefusee('reponse_trop_grosse');
    }
    bouts.push(x.value);
  }
  return new Response(res.status === 204 ? null : Buffer.concat(bouts), { status: res.status, headers: res.headers });
}

/** Découverte, inscription, jetons, révocation : les hôtes OAuth de CE service, et eux seuls. */
export const sortieOAuth = (c: Connecteur, d: Deps = {}) => {
  const hotes = [new URL(c.oauth.emetteur).host, c.oauth.jeton, c.oauth.enregistrement, c.oauth.revocation];
  return async (url: string, o: Options = {}): Promise<Response> => partir(tenirAdresse(url, hotes, d), o, { max: OAUTH_MAX_OCTETS, delaiMs: OAUTH_DELAI_MS }, d);
};

/** Le serveur MCP de ce service, à son adresse exacte : le jeton de la personne ne va nulle part ailleurs. */
export const sortieMcp = (c: Connecteur, d: Deps = {}) => async (url: string, o: Options = {}): Promise<Response> => {
  if (url !== c.mcpUrl) throw new SortieRefusee('hote_inattendu');
  return partir(tenirAdresse(url, [new URL(c.mcpUrl).host], d), o, { max: MCP_MAX_OCTETS, delaiMs: MCP_DELAI_MS }, d);
};
