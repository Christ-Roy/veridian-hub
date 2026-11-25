/**
 * Les administrateurs de plateforme : des PERSONNES, par leur `hub_user_id` (`PLATFORM_ADMINS`), jamais par une adresse (VER-263). Une adresse se tape à
 * l'inscription, se recycle, et la liste d'adresses était lisible dans ce dépôt public. Même règle que `HUB_SERVER_ADMIN_HUB_USER_IDS` du CRM : une liste
 * illisible (absente, vide, une seule entrée qui n'est pas un identifiant) ne promeut et ne déchoit personne, la liste connue reste celle du code.
 * Sans base ni node:crypto : lu aussi par le garde du middleware (edge).
 */

/** Liste connue, celle que rend le job de prod (`__tests__/contrat/admins-plateforme.test.ts` le tient). */
export const ADMINS_CONNUS: ReadonlySet<string> = new Set(['53245ae1-6bf8-4ec6-870f-32d75b7c0281']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const liste = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** `null` : illisible. Une liste lue à moitié n'est pas lue. */
export function lireAdmins(v: string | undefined): ReadonlySet<string> | null {
  const ids = liste(v);
  return ids.length > 0 && ids.every((id) => UUID.test(id)) ? new Set(ids) : null;
}

let dit = false;
export function adminsPlateforme(): ReadonlySet<string> {
  const lue = lireAdmins(process.env.PLATFORM_ADMINS);
  if (lue) return lue;
  if (!dit) {
    dit = true;
    console.error(JSON.stringify({ tag: '[admin][critical]', level: 'error', msg: 'PLATFORM_ADMINS illisible : liste connue gardée, personne promu ni déchu', ts: new Date().toISOString() }));
  }
  return ADMINS_CONNUS;
}

export const isPlatformAdminId = (hubUserId: string | null | undefined): boolean => !!hubUserId && adminsPlateforme().has(hubUserId.toLowerCase());

/** Pour un RAPPORT seulement (qui est l'opérateur dans un espace client) : n'ouvre aucun droit. */
export const estAdresseOperateur = (email: string): boolean => liste(process.env.ADRESSES_OPERATEUR).includes(email.trim().toLowerCase());
