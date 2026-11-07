/**
 * Dernier filet, même si la batterie a planté : retire ce qui reste au registre, mesure, et écrit le
 * verdict que le lanceur relit. Un reste fait échouer la commande. Ne touche QU'aux comptes du registre.
 */
import { NonAbouti } from './lib/etat';
import { ecrireVerdictRestes, mesurerRestes, nettoyerTout } from './lib/nettoyage';

export default async function () {
  const { echecs } = await nettoyerTout();
  try {
    ecrireVerdictRestes({ echecs, restes: await mesurerRestes() });
  } catch (e) {
    if (!(e instanceof NonAbouti) && !(e instanceof Error)) throw e;
    ecrireVerdictRestes({ echecs, nonAbouti: (e as Error).message.slice(0, 200) });
  }
}
