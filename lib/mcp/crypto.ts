import { createHash, randomBytes } from 'node:crypto';

/** Secret aléatoire, base64url, préfixé pour le reconnaître dans un journal sans le révéler. */
export function jetonAleatoire(prefixe: string): string {
  return `${prefixe}_${randomBytes(32).toString('base64url')}`;
}

/** Seule forme stockée d'un code ou d'un jeton. */
export function empreinte(valeur: string): string {
  return createHash('sha256').update(valeur).digest('hex');
}

/** PKCE S256 (RFC 7636) : le vérificateur suit la grammaire, son empreinte égale le défi. */
export function pkceValide(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}
