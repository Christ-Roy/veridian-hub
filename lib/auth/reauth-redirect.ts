/**
 * Côté navigateur : une API a demandé une connexion récente (`recent_auth_required`). On y renvoie
 * l'utilisateur, avec retour sur la page en cours. `true` si la redirection part.
 */
export function redirectIfReauthRequired(data: { error?: unknown; login_url?: unknown }): boolean {
  if (data.error !== 'recent_auth_required' || typeof data.login_url !== 'string') return false;
  window.location.href = `${data.login_url}&callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  return true;
}
