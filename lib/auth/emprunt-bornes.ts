/**
 * Les bornes d'un emprunt (VER-263), sans base ni node:crypto : le garde du middleware (edge) les lit aussi.
 */
import { isPlatformAdminId } from '@/lib/admin/liste-admins';

/** Une heure à partir du début réel : un geste d'assistance, pas une session. */
export const IMPERSONATION_SESSION_TTL_S = 60 * 60;

/** Emprunt ouvert par la clé d'administration (`hub open`, batterie) : aucune personne connue. */
export const PAR_CLE = 'cle:ADMIN_SECRET';

/** Auth.js re-signe le jeton à chaque lecture (D5) : la fin se lit sur `authAt`. Sans lui : expirée (échec fermé). */
export function impersonationExpiree(token: { impersonated?: unknown; authAt?: unknown }, nowS: number = Math.floor(Date.now() / 1000)): boolean {
  if (token.impersonated !== true) return false;
  if (typeof token.authAt !== 'number') return true;
  return nowS - token.authAt > IMPERSONATION_SESSION_TTL_S;
}

/** L'emprunteur n'est plus administrateur : ses emprunts finissent avec. */
export function empruntRetire(token: { impersonated?: unknown; impersonatedBy?: unknown }): boolean {
  if (token.impersonated !== true) return false;
  return token.impersonatedBy !== PAR_CLE && !(typeof token.impersonatedBy === 'string' && isPlatformAdminId(token.impersonatedBy));
}

/** Les seuls gestes d'un emprunteur au Hub : en sortir, se déconnecter, choisir où les apps ouvriront (un cookie, revérifié). */
const GESTES_PERMIS = ['/api/auth/emprunt/', '/api/auth/signout', '/api/organisations/active'];
/** Des lectures qui n'en sont pas : elles attachent une boîte ou un service au compte du client. */
const LECTURES_REFUSEES = ['/api/gmail/connect', '/api/connecteurs/'];

export function gesteRefuseEnEmprunt(methode: string, chemin: string): boolean {
  const sous = (p: string) => chemin === p || chemin.startsWith(p.endsWith('/') ? p : `${p}/`);
  if (['GET', 'HEAD', 'OPTIONS'].includes(methode.toUpperCase())) return LECTURES_REFUSEES.some(sous);
  return !GESTES_PERMIS.some(sous);
}
