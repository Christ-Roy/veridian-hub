/**
 * Preuve récente pour les actions sensibles. Avec une session d'un an, être connecté ne prouve
 * plus que la personne est bien devant l'écran : on exige une connexion réelle récente. La date
 * `authAt` ne glisse pas quand la session se renouvelle.
 */

import { NextResponse } from 'next/server';

import { auth } from '@/auth';

/** Compte, email, mot de passe, administration. */
export const PREUVE_COMPTE_S = 24 * 60 * 60;
/** Facturation : assez large pour ne pas casser un achat, Stripe redemande de toute façon la carte. */
export const PREUVE_FACTURATION_S = 7 * 24 * 60 * 60;

export function isAuthRecent(authAt: number | undefined, maxAgeS: number, nowMs = Date.now()): boolean {
  return typeof authAt === 'number' && nowMs / 1000 - authAt <= maxAgeS;
}

/**
 * Refus des actions qui changent le compte (mot de passe, email) pour une session impersonée
 * (D5). L'impersonation sert au support : elle ne doit ni verrouiller le client hors de son
 * compte, ni changer ses identifiants sans trace côté client.
 */
export async function denyIfImpersonated(): Promise<NextResponse | null> {
  const session = await auth();
  if (session?.user?.impersonated !== true) return null;
  return NextResponse.json(
    {
      error: 'impersonation_interdite',
      message: "Cette action n'est pas permise pendant une session d'assistance.",
    },
    { status: 403 },
  );
}

/** Réponse de refus si la dernière connexion réelle est trop ancienne, sinon `null`. */
export async function denyUnlessRecentAuth(maxAgeS: number): Promise<NextResponse | null> {
  const session = await auth();
  if (session?.user?.impersonated === true) return null;
  if (isAuthRecent(session?.user?.authAt, maxAgeS)) return null;
  return NextResponse.json(
    {
      error: 'recent_auth_required',
      message: 'Pour cette action, reconnectez-vous : votre dernière connexion est trop ancienne.',
      login_url: '/login?reauth=1',
    },
    { status: 403 },
  );
}
