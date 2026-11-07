/**
 * Forme canonique d'une adresse dans le Hub : sans espaces autour, en minuscules (D6).
 * La base stocke ainsi les adresses (inscription), donc toute recherche, comparaison et
 * écriture passe par ici. Sans cela, `Robert@X.com` ne se connecte jamais à `robert@x.com`,
 * et une adresse en majuscules échappe au contrôle de doublon.
 */
export function normaliserEmail(brut: string): string {
  return brut.trim().toLowerCase();
}
