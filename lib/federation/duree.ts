/**
 * Combien de temps vit une session ouverte par le fournisseur d'une organisation (D6, VER-261). Sans réglage : 24 h depuis la connexion réelle. Réglée en
 * jours par l'organisation : glissante (l'usage la renouvelle), et jamais plus de 30 jours depuis la connexion réelle : quitter le fournisseur sans être
 * retiré au Hub a donc toujours une fin. Le retrait au Hub, lui, coupe à la lecture suivante, quel que soit l'âge (lib/federation/borne.ts).
 * Sans dépendance : lu aussi par le middleware.
 */
export const SESSION_FEDEREE_S = 24 * 60 * 60;
export const SESSION_FEDEREE_MAX_S = 30 * 24 * 60 * 60;
export const JOURS_MAX = 30;
/** On ne réécrit « vue » qu'une fois par heure. */
const PAS_S = 60 * 60;

export type JetonFedere = { federe?: unknown; authAt?: unknown; federeVu?: unknown; federeJours?: unknown };
/** Entier de 2 à 30 ; tout le reste vaut la règle de 24 h. */
export const joursValables = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 2 && x <= JOURS_MAX ? x : null);

/** Sans début connu : expirée. `jours` : le réglage relu en base, quand on peut ; sinon celui du jeton. */
export function federationExpiree(token: JetonFedere, nowS = Math.floor(Date.now() / 1000), jours: number | null = joursValables(token.federeJours)): boolean {
  if (token.federe !== true) return false;
  if (typeof token.authAt !== 'number') return true;
  if (!jours) return nowS - token.authAt > SESSION_FEDEREE_S;
  const vu = typeof token.federeVu === 'number' ? token.federeVu : token.authAt;
  return nowS - vu > jours * 86_400 || nowS - token.authAt > SESSION_FEDEREE_MAX_S;
}

/** L'usage renouvelle. Jamais une session déjà finie. */
export function glisser<T extends JetonFedere>(token: T, nowS = Math.floor(Date.now() / 1000)): T {
  if (token.federe !== true || !joursValables(token.federeJours) || federationExpiree(token, nowS)) return token;
  const vu = typeof token.federeVu === 'number' ? token.federeVu : 0;
  return nowS - vu > PAS_S ? { ...token, federeVu: nowS } : token;
}
