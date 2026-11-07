/**
 * Cookie signé « étape 1 réussie » de la double vérification (D3).
 *
 * Le mot de passe est vérifié par `POST /api/auth/mfa/start`, qui envoie le code par mail et
 * pose ce cookie. `POST /api/auth/mfa/verify` exige ce cookie avant de vérifier le code, puis
 * émet la session. Le cookie lie donc le code au navigateur qui a passé le mot de passe.
 *
 * Forme : `base64url(uid).exp.HMAC-SHA256(secret, "mfa-step1|" + base64url(uid) + "." + exp)`.
 * Durée courte (5 min, comme la validité d'un code), liée à l'utilisateur, sans état serveur.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { secureCookiesEnabled } from '@/lib/auth/impersonation';

/** Nom du cookie d'étape 1 : préfixe `__Secure-` en HTTPS, comme la session. */
export function mfaStep1CookieName(secure = secureCookiesEnabled()): string {
  return secure ? '__Secure-veridian-mfa1' : 'veridian-mfa1';
}

/** Durée de vie du cookie d'étape 1 : 5 minutes. */
export const MFA_STEP1_TTL_S = 5 * 60;

function signature(corps: string, secret: string): string {
  return createHmac('sha256', secret).update(`mfa-step1|${corps}`).digest('base64url');
}

/** Valeur du cookie pour cet utilisateur, valable jusqu'à `nowS + MFA_STEP1_TTL_S`. */
export function signerEtapeUn(uid: string, nowS: number, secret: string): string {
  const corps = `${Buffer.from(uid).toString('base64url')}.${nowS + MFA_STEP1_TTL_S}`;
  return `${corps}.${signature(corps, secret)}`;
}

/** Renvoie l'utilisateur si le cookie est authentique et non expiré, sinon `null`. */
export function verifierEtapeUn(
  valeur: string | undefined | null,
  secret: string,
  nowS: number,
): string | null {
  if (!valeur) return null;
  const morceaux = valeur.split('.');
  if (morceaux.length !== 3) return null;
  const [uidB64, expStr, sig] = morceaux;
  const corps = `${uidB64}.${expStr}`;
  const attendue = Buffer.from(signature(corps, secret));
  const recue = Buffer.from(sig);
  if (attendue.length !== recue.length || !timingSafeEqual(attendue, recue)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || nowS > exp) return null;
  return Buffer.from(uidB64, 'base64url').toString('utf8');
}

/** Valeur du cookie d'étape 1 lue dans l'en-tête `Cookie` d'une requête. */
export function lireEtapeUn(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  const nom = mfaStep1CookieName();
  for (const morceau of cookieHeader.split(';')) {
    const [cle, ...reste] = morceau.trim().split('=');
    if (cle === nom) return reste.join('=');
  }
  return undefined;
}
