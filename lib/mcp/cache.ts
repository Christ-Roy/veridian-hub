/**
 * Caches de la porte MCP, en mémoire du processus (le Hub tourne en une instance). Outils : 5 min par
 * app et par utilisateur. Échec : 30 s par app et par utilisateur, pour qu'une app en panne ne fasse
 * pas attendre son délai à chaque appel, et vidé dès que le Hub crée le compte de cet utilisateur
 * dans une app (sinon le premier appel après la création dirait encore « injoignable »).
 */
export const TTL_OUTILS_MS = 5 * 60_000;
export const TTL_ECHEC_MS = 30_000;

export const cacheOutils = new Map<string, { a: number; outils: unknown[] }>();
export const cacheEchecs = new Map<string, { a: number; raison: string }>();

export const cle = (appKey: string, hubUserId: string) => `${appKey}:${hubUserId}`;

export function viderCache() {
  cacheOutils.clear();
  cacheEchecs.clear();
}

/** À appeler quand un compte d'app est créé ou relié pour cet utilisateur. */
export function oublierUtilisateur(hubUserId: string, appKey?: string) {
  for (const m of [cacheOutils, cacheEchecs] as Map<string, unknown>[]) {
    for (const k of Array.from(m.keys())) {
      const [app, user] = k.split(':');
      if (user === hubUserId && (!appKey || app === appKey)) m.delete(k);
    }
  }
}
