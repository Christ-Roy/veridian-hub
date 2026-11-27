/**
 * Signature des appels SORTANTS du Hub vers les apps (Mail/Notifuse, Prospection, CRM, Analytics, Academy, CMS).
 * Seul point de signature : aucun appelant ne calcule plus lui-même son HMAC.
 *
 * Deux versions, choisies par app :
 *  - v1 : `hex(HMAC-SHA256(secret, ts + "." + corps))`. Elle ne lie ni la méthode, ni le chemin, ni la query : une signature
 *    captée sur un GET vaut 5 min pour un DELETE d'un autre tenant (faille signalée par la session Mail, 26/11).
 *  - v2 : `hex(HMAC-SHA256(secret, ts + "\n" + MÉTHODE + "\n" + chemin + "\n" + query + "\n" + hex(sha256(corps))))`,
 *    en-tête `X-Veridian-Sig-Version: 2`. Référence côté serveur : `veridianHubMACv2` dans
 *    `notifuse-veridian/internal/http/middleware/veridian_hmac.go`. Usage unique côté serveur : chaque envoi, et chaque
 *    nouvel essai, doit donc appeler `entetesSignature` de nouveau (timestamp neuf).
 *
 * Interrupteur : la variable d'environnement `HMAC_V2_APPS`, liste séparée par des virgules (ex. `notifuse,crm`), lue à
 * CHAQUE appel. Vide ou absente : v1 partout, octet pour octet comme avant. On n'allume une app que lorsque l'app sait
 * vérifier la v2.
 *
 * Clés d'app canoniques (celles de `SyncApp`) : `notifuse`, `prospection`, `analytics`, `crm`, `academy`, `cms`.
 * `twenty` est accepté comme alias de `crm`, dans l'appel comme dans la variable.
 */
import { createHash, createHmac } from 'node:crypto';

export const VERSION_V2 = '2';

/** Nom canonique d'une app : minuscules, sans espace, `twenty` ramené à `crm`. */
function canonique(app: string): string {
  const a = app.trim().toLowerCase();
  return a === 'twenty' ? 'crm' : a;
}

/** Les apps qui signent en v2, lues dans l'environnement à chaque appel. */
export function appsEnV2(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.HMAC_V2_APPS ?? '')
      .split(',')
      .map(canonique)
      .filter((a) => a.length > 0),
  );
}

export type EntreeSignature = {
  secret: string;
  methode: string;
  /** L'URL complète qui part sur le fil : le chemin et la query signés en sont extraits tels quels. */
  url: string;
  /** Les octets exacts du corps envoyé ; vide ou absent pour un GET et un DELETE sans corps. */
  corps?: string | null;
  /** Clé canonique de l'app visée. */
  app: string;
  /** Instant de la signature en ms ; `Date.now()` par défaut. */
  maintenant?: number;
  env?: NodeJS.ProcessEnv;
};

/** En-têtes de signature à poser sur UNE requête (pas de réutilisation d'un essai à l'autre). */
export function entetesSignature(e: EntreeSignature): Record<string, string> {
  const timestamp = String(e.maintenant ?? Date.now());
  const corps = e.corps ?? '';
  if (!appsEnV2(e.env).has(canonique(e.app))) {
    return {
      'X-Veridian-Timestamp': timestamp,
      'X-Veridian-Hub-Signature': createHmac('sha256', e.secret).update(`${timestamp}.${corps}`).digest('hex'),
    };
  }
  const u = new URL(e.url);
  const empreinteCorps = createHash('sha256').update(corps).digest('hex');
  const canon = [timestamp, e.methode.toUpperCase(), u.pathname, u.search.replace(/^\?/, ''), empreinteCorps].join('\n');
  return {
    'X-Veridian-Timestamp': timestamp,
    'X-Veridian-Hub-Signature': createHmac('sha256', e.secret).update(canon).digest('hex'),
    'X-Veridian-Sig-Version': VERSION_V2,
  };
}
