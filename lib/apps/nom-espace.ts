/**
 * Le nom qu'un espace reçoit dans une app quand le Hub le crée. Un compte d'épreuve (`estCompteDeTest`) donne un nom préfixé `e2e-` :
 * le CRM tire son sous-domaine du nom, et des espaces d'essai prenaient `veridian`, trop proche d'un vrai espace (garde de
 * twenty-admin, variables TWENTY_PROD_VERIDIAN_*) (parente, 26/11). Un client garde son nom tel quel.
 */
import { estCompteDeTest } from '@/lib/email/compte-de-test';

export function nomDEspace(nom: string | null | undefined, proprietaire: string): string {
  const n = (nom ?? '').trim();
  if (!estCompteDeTest(proprietaire)) return n;
  return /^e2e-/i.test(n) ? n : `e2e-${n || 'essai'}`;
}
