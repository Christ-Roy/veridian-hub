/**
 * L'organisation que ce navigateur a déjà ouverte (VER-261) : un nom de porte, sans aucune valeur de session. Il sert à proposer le bon bouton, et à partir
 * seul vers le fournisseur ; jamais deux fois de suite : après un essai ou une déconnexion, la page attend un clic.
 */
import type { NextResponse } from 'next/server';

export const COOKIE_PORTE = 'veridian-porte';
export const COOKIE_PAUSE = 'veridian-porte-pause';
const UN_AN_S = 365 * 24 * 3600;
export const PAUSE_ESSAI_S = 2 * 60;
export const PAUSE_DECONNEXION_S = 10 * 60;

export const porteValable = (x: string | undefined): string | null => (x && /^[a-z0-9][a-z0-9-]{0,80}$/.test(x) ? x : null);

export function retenirPorte(r: NextResponse, porte: string, secure: boolean): void {
  r.cookies.set(COOKIE_PORTE, porte, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: UN_AN_S });
}
/** Le temps d'un essai ou d'une déconnexion, aucun départ automatique. */
export function pauserPorte(r: NextResponse, secondes: number, secure: boolean): void {
  r.cookies.set(COOKIE_PAUSE, '1', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: secondes });
}
export const pauseSetCookie = (secondes: number, secure: boolean): string => `${COOKIE_PAUSE}=1; Path=/; Max-Age=${secondes}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
