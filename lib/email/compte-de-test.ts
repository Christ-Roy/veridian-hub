/**
 * Les adresses des comptes d'épreuve (batterie système), UNE seule source. Elles n'ont pas de boîte : leur écrire pour de vrai fait un rebond dur, et
 * 16 rebonds sur 64 envois en dix jours ont abîmé le compte qui porte les codes et les invitations des clients (parente, 25/11).
 * Ancrée des deux côtés, notre domaine seul : une adresse de client ne peut pas s'y trouver.
 */
export const COMPTE_DE_TEST = /^e2e-sso-[a-z0-9-]+@veridian\.site$/;

export const estCompteDeTest = (adresse: string): boolean => COMPTE_DE_TEST.test(adresse.trim().toLowerCase());
