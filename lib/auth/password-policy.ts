/**
 * Règle unique du mot de passe Hub : 8 à 72 caractères.
 * 72 = limite de bcrypt (au-delà, le reste est ignoré). C'est la règle que les routes serveur
 * imposent toutes (inscription, réglages, reset, activation) ; les écrans la reprennent d'ici.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

export const PASSWORD_RULE_TEXT = `Entre ${PASSWORD_MIN} et ${PASSWORD_MAX} caractères.`;

/** Message d'erreur à afficher, ou null si le mot de passe respecte la règle. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Le mot de passe doit contenir au plus ${PASSWORD_MAX} caractères.`;
  }
  return null;
}
