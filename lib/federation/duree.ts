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

/** Une session propre, passée par le fournisseur d'une organisation : quand, vue quand, par quel fournisseur (`i`), pour combien de jours. */
export type PreuveOrg = { le: number; vu: number; i: string; j?: number };
/** Le jeton est un cookie : on n'y garde que les dernières. */
export const PREUVES_MAX = 5;
export type JetonFedere = { federe?: unknown; authAt?: unknown; federeVu?: unknown; federeJours?: unknown; preuves?: unknown };
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

const estPreuve = (p: unknown): p is PreuveOrg => typeof p === 'object' && p !== null && typeof (p as PreuveOrg).le === 'number' && typeof (p as PreuveOrg).vu === 'number' && typeof (p as PreuveOrg).i === 'string';

/** Les preuves encore valables, glissées comme une session. `undefined` : aucune. */
export function preuvesVivantes(x: unknown, nowS = Math.floor(Date.now() / 1000)): Record<string, PreuveOrg> | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  const vives = Object.entries(x as Record<string, unknown>)
    .filter((e): e is [string, PreuveOrg] => estPreuve(e[1]) && !federationExpiree({ federe: true, authAt: e[1].le, federeVu: e[1].vu, federeJours: e[1].j }, nowS))
    .sort((a, b) => b[1].le - a[1].le)
    .slice(0, PREUVES_MAX)
    .map(([k, p]) => [k, joursValables(p.j) && nowS - p.vu > PAS_S ? { ...p, vu: nowS } : p] as const);
  return vives.length ? Object.fromEntries(vives) : undefined;
}

/** L'usage renouvelle. Jamais une session déjà finie. */
export function glisser<T extends JetonFedere>(token: T, nowS = Math.floor(Date.now() / 1000)): T {
  if (token.preuves !== undefined) token = { ...token, preuves: preuvesVivantes(token.preuves, nowS) };
  if (token.federe !== true || !joursValables(token.federeJours) || federationExpiree(token, nowS)) return token;
  const vu = typeof token.federeVu === 'number' ? token.federeVu : 0;
  return nowS - vu > PAS_S ? { ...token, federeVu: nowS } : token;
}
