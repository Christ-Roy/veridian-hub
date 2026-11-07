/**
 * Validation du `callbackUrl` des formulaires de connexion et d'inscription (D8).
 *
 * Seul un chemin interne est accepté : il commence par UN `/`. Refusés : les URL absolues
 * (`https://…`), les chemins réseau (`//hote`, `/\hote` : les navigateurs les lisent comme
 * un autre site), `javascript:`, et les caractères de contrôle. Tout le reste retombe sur
 * `repli`. Un `router.push` vers une URL externe ferait sortir l'utilisateur du Hub après
 * une vraie connexion, et l'URL pourrait être piégée dans un lien.
 */
export function safeCallback(raw: string | null | undefined, repli = '/dashboard'): string {
  if (!raw) return repli;
  if (!raw.startsWith('/')) return repli;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return repli;
  // Contrôles (tabulation, retour chariot…) et antislash : les navigateurs les normalisent
  // parfois en séparateur d'hôte.
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return repli;
  return raw;
}
