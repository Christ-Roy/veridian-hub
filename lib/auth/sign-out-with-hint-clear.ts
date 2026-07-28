'use client';

/**
 * Déconnexion côté client — signOut Auth.js + suppression du cookie hint.
 *
 * Le `signOut()` de next-auth ne supprime QUE le cookie session Auth.js. Le
 * hint cross-subdomain `veridian-session-hint` (scope .veridian.site, TTL
 * 30j, lisible JS) lui survivait, laissant la landing veridian.site afficher
 * un utilisateur connecté après sa déconnexion.
 *
 * Le vrai correctif est **serveur** : le wrapper du POST /api/auth/signout
 * (`app/api/auth/[...nextauth]/route.ts`) greffe le Set-Cookie de suppression
 * sur la réponse Auth.js, ce qui couvre TOUS les appelants — bouton, server
 * action, appel direct à l'endpoint. Ce helper est la bretelle : il couvre le
 * cas où la réponse serveur ne porterait pas le cookie (proxy qui filtre les
 * Set-Cookie sur redirection, réponse servie depuis un cache).
 *
 * Best-effort strict : un échec du clear ne doit JAMAIS empêcher la
 * déconnexion. On avale l'erreur et on enchaîne sur le signOut.
 */

import { signOut } from 'next-auth/react';

/** Route publique idempotente qui renvoie le Set-Cookie de suppression. */
export const SESSION_HINT_CLEAR_ENDPOINT = '/api/auth/session-hint/clear';

export async function clearSessionHint(): Promise<void> {
  try {
    await fetch(SESSION_HINT_CLEAR_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    /* noop — la déconnexion prime, le serveur clear déjà au signOut */
  }
}

/**
 * Remplace `signOut()` dans les composants de navigation.
 *
 * L'ordre compte : on efface le hint AVANT le signOut, parce que le signOut
 * navigue (redirection vers callbackUrl) et peut interrompre une requête en
 * vol.
 */
export async function signOutWithHintClear(options?: {
  callbackUrl?: string;
}): Promise<void> {
  await clearSessionHint();
  await signOut(options);
}
