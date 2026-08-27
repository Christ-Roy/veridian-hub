/**
 * Double acceptation d'un secret de webhook pendant une fenêtre de rotation.
 *
 * Problème résolu
 * ---------------
 * Un secret partagé entre un émetteur et un récepteur ne peut pas être changé
 * de façon atomique : il y a toujours un intervalle pendant lequel l'un des
 * deux côtés porte encore l'ancienne valeur. Une rotation sèche coupe donc le
 * trafic pendant cet intervalle.
 *
 * La parade est de rendre le RÉCEPTEUR tolérant : pendant la fenêtre de
 * bascule il accepte l'ancienne ET la nouvelle valeur. On déploie d'abord
 * cette tolérance, ensuite les émetteurs, et on ne retire l'ancienne valeur
 * qu'une fois mesuré que plus personne ne l'utilise.
 *
 * Convention d'environnement
 * --------------------------
 *   <NOM>            valeur COURANTE (celle que les émetteurs doivent porter)
 *   <NOM>_PREVIOUS   valeur HÉRITÉE, acceptée en plus, à retirer après bascule
 *
 * `<NOM>_PREVIOUS` est optionnel. Absent, le comportement est strictement
 * celui d'avant l'introduction de ce module : une seule valeur acceptée.
 *
 * Mesure de la bascule
 * --------------------
 * Toute acceptation émet une ligne de log structurée à préfixe stable :
 *
 *   [webhook-auth] app=<app> channel=<canal> key=current|previous outcome=accepted
 *   [webhook-auth] app=<app> channel=<canal> key=none outcome=rejected
 *
 * C'est cette ligne qui PROUVE la bascule : tant qu'on observe `key=previous`,
 * un émetteur porte encore l'ancien secret et le retrait est prématuré. Le
 * champ `key` ne révèle jamais la valeur, seulement laquelle des deux a servi.
 *
 * Aucune valeur de secret ne doit être journalisée ici, ni en clair ni tronquée.
 */

import { timingSafeEqual } from 'node:crypto';

/** Laquelle des deux valeurs a validé la requête. */
export type SecretKeyUsed = 'current' | 'previous' | 'none';

/** Paire de secrets acceptés pendant une fenêtre de rotation. */
export interface RotatingSecret {
  /** Valeur courante. Toujours définie si le secret est configuré. */
  current: string;
  /** Valeur héritée, acceptée en plus. `null` hors fenêtre de rotation. */
  previous: string | null;
}

/**
 * Lit `<name>` et `<name>_PREVIOUS` dans l'environnement.
 *
 * Renvoie `null` si la valeur courante est absente ou vide — le caller doit
 * alors répondre 500 « not configured », comme avant. Une `_PREVIOUS` vide ou
 * égale à la courante est ignorée (cas d'un déploiement où la variable a été
 * laissée en place après la fin de la rotation).
 */
export function readRotatingSecret(name: string): RotatingSecret | null {
  const current = process.env[name];
  if (!current) return null;

  const previous = process.env[`${name}_PREVIOUS`];
  if (!previous || previous === current) {
    return { current, previous: null };
  }
  return { current, previous };
}

/**
 * Comparaison en temps constant de deux chaînes.
 *
 * `timingSafeEqual` exige des buffers de même longueur : on court-circuite sur
 * la longueur, ce qui ne fuit que la taille du secret, pas son contenu.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Confronte une valeur présentée aux deux valeurs acceptées.
 *
 * Les deux comparaisons sont TOUJOURS exécutées (pas de court-circuit sur la
 * première) pour ne pas transformer le temps de réponse en oracle indiquant
 * quelle valeur a servi.
 */
export function matchRotatingSecret(
  presented: string,
  secret: RotatingSecret,
): SecretKeyUsed {
  const okCurrent = constantTimeEquals(presented, secret.current);
  const okPrevious = secret.previous
    ? constantTimeEquals(presented, secret.previous)
    : false;

  if (okCurrent) return 'current';
  if (okPrevious) return 'previous';
  return 'none';
}

/**
 * Généralisation de `matchRotatingSecret` aux schémas où la valeur présentée
 * n'est pas comparable directement — typiquement une signature HMAC, qu'il
 * faut recalculer avec chaque secret candidat.
 *
 * `verify` reçoit un secret candidat et répond si la requête est valide pour
 * ce secret. Les deux candidats sont toujours évalués, même raison que plus haut.
 */
export function matchRotatingSecretWith(
  secret: RotatingSecret,
  verify: (candidate: string) => boolean,
): SecretKeyUsed {
  const okCurrent = verify(secret.current);
  const okPrevious = secret.previous ? verify(secret.previous) : false;

  if (okCurrent) return 'current';
  if (okPrevious) return 'previous';
  return 'none';
}

/**
 * Émet la ligne de log qui rend la bascule mesurable.
 *
 * Préfixe volontairement stable et unique : c'est la clé de recherche dans
 * Loki (`{job="hub"} |= "[webhook-auth]"`). Ne pas le renommer sans mettre à
 * jour les requêtes d'observabilité et le runbook de rotation.
 *
 * Une acceptation par `previous` est un WARN et non un INFO : c'est le signal
 * qu'un émetteur n'a pas encore basculé, donc que la fenêtre doit rester
 * ouverte. Il vaut mieux qu'il soit bruyant.
 */
export function logWebhookAuth(
  app: string,
  channel: string,
  key: SecretKeyUsed,
): void {
  const line = `[webhook-auth] app=${app} channel=${channel} key=${key} outcome=${
    key === 'none' ? 'rejected' : 'accepted'
  }`;
  if (key === 'previous') {
    console.warn(`${line} note=emetteur_sur_ancien_secret`);
  } else if (key === 'none') {
    console.warn(line);
  } else {
    console.info(line);
  }
}
