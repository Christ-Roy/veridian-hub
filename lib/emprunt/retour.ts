/**
 * Revenir à soi : la session de l'administrateur attend dans un second cookie, chiffré, lié à UN emprunt, et ne se rend qu'à la session de cet emprunt encore
 * vivante. Déconnecté ou expiré : il faut se reconnecter. Une session révoquée entre-temps reste révoquée (relue en base à chaque lecture).
 */
import { decode, encode } from 'next-auth/jwt';

import { IMPERSONATION_SESSION_TTL_S, secureCookiesEnabled } from '@/lib/auth/impersonation';

export const cookieRetour = (secure = secureCookiesEnabled()) => (secure ? '__Secure-veridian-retour' : 'veridian-retour');
export const CHEMIN_RETOUR = '/api/auth/emprunt';
const SEL = 'veridian-retour';
export type Retour = { empruntId: string; session: string; org: string | null };

export async function scellerRetour(r: Retour): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET requis');
  return encode({ salt: SEL, secret, maxAge: IMPERSONATION_SESSION_TTL_S, token: { ...r } });
}

export async function lireRetour(valeur: string | undefined, empruntId: string): Promise<Retour | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !valeur) return null;
  const t = await decode({ salt: SEL, secret, token: valeur }).catch(() => null);
  if (!t || t.empruntId !== empruntId || typeof t.session !== 'string') return null;
  return { empruntId, session: t.session, org: typeof t.org === 'string' ? t.org : null };
}
