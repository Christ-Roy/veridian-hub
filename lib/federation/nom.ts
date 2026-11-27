/** Le nom qu'une personne connaît de son fournisseur. Sans dépendance. */
const CONNUS: Record<string, string> = { 'login.infomaniak.com': 'Infomaniak', 'accounts.google.com': 'Google', 'login.microsoftonline.com': 'Microsoft' };
export function nomFournisseur(issuer: string): string {
  try {
    const h = new URL(issuer).hostname;
    return CONNUS[h] ?? h;
  } catch {
    return 'votre organisation';
  }
}
