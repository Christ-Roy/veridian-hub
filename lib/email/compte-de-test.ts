/**
 * Les adresses des comptes d'épreuve (batterie système), UNE seule source. Elles n'ont pas de boîte : leur écrire pour de vrai fait un rebond dur, et
 * 16 rebonds sur 64 envois en dix jours ont abîmé le compte qui porte les codes et les invitations des clients (parente, 25/11).
 * Ancrée des deux côtés, notre domaine seul : une adresse de client ne peut pas s'y trouver.
 */
export const COMPTE_DE_TEST = /^e2e-sso-[a-z0-9-]+@veridian\.site$/;

export const estCompteDeTest = (adresse: string): boolean => COMPTE_DE_TEST.test(adresse.trim().toLowerCase());

/**
 * Miroir de `IDENTITE_DE_TEST` d'Analytics (`server/src/api/veridian/traficDeTest.ts`, 27/11) : cette identité vers un site réel y est
 * refusée en 403. Le Hub n'en émet donc aucune vers la vitrine. Plus large que `estCompteDeTest` (qui garde les envois de mails) :
 * ici on coupe une émission, pas une boîte. À garder alignée sur Analytics.
 */
export const IDENTITE_DE_TEST_ANALYTICS = /^(?:recette(?:[-_].*)?|robert-test(?:[-_].*)?|e2e[-_].+|e2e-sso-[^@]+@veridian\.site)$/i;

export const estIdentiteDeTestAnalytics = (identite: string): boolean => IDENTITE_DE_TEST_ANALYTICS.test(identite.trim());
