/**
 * Boîte de lecture des épreuves par mail. ELLE N'EXISTE PLUS : Lark a été abandonné le 16/11/2026, et les comptes `pro` et `gmail` du CLI `mail` sont
 * la boîte de Robert, que personne ne lit, ne liste, ne cherche ni ne vide (parente, 25/11). Ne pas la remplacer par l'une d'elles, ni par un jeton
 * tiré de la base ou des journaux : ce ne serait plus le parcours d'un client. Tant qu'une boîte isolée n'existe pas, ces cas sont NON ABOUTIS, et
 * ils s'arrêtent AVANT d'envoyer quoi que ce soit.
 */
import { NonAbouti } from './etat';

export const ADRESSE_PREUVE = 'e2e-sso-preuve@veridian.site';
const RAISON = 'aucune boîte d\'épreuve : Lark abandonné le 16/11, la boîte de Robert ne se lit pas (parente, 25/11). Aucun mail envoyé.';

/** À appeler en premier, avant tout geste qui ferait partir un mail. */
export function exigerBoite(): void {
  throw new NonAbouti(RAISON);
}

export async function lienDePreuve(_adresse: string, _depuis: Date): Promise<string> {
  throw new NonAbouti(RAISON);
}

export async function attendreMail(_adresse: string, _objet: string, _depuis: Date): Promise<string> {
  throw new NonAbouti(RAISON);
}
