/**
 * Régler une liaison ET ce qui la fait vivre : un événement a besoin de son abonnement chez la source. Un seul chemin pour l'écran et pour
 * l'IA : sans abonnement, la liaison s'éteint aussitôt plutôt que de se dire allumée pour rien. Couper n'est jamais empêché.
 */
import { suivreAbonnement } from '@/lib/evenements/allumage';

import { reglerIntegration } from './interrupteur';

type Db = Parameters<typeof reglerIntegration>[0] & Parameters<typeof suivreAbonnement>[0];
type Demande = Parameters<typeof reglerIntegration>[1];

export async function reglerEtSuivre(db: Db, d: Demande): Promise<Awaited<ReturnType<typeof reglerIntegration>> | { refus: 'source_injoignable' }> {
  const r = await reglerIntegration(db, d);
  if (!('etat' in r) || r.etat === 'a_confirmer') return r;
  const s = await suivreAbonnement(db, { tenantId: d.tenantId, paire: d.paire, actif: r.etat === 'allumee' });
  if (s !== 'echec' || r.etat !== 'allumee') return r;
  await reglerIntegration(db, { ...d, etat: 'eteinte', client: 'Veridian, abonnement impossible' });
  return { refus: 'source_injoignable' };
}
