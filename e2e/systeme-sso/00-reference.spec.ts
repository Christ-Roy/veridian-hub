/**
 * Référence de dérives AVANT toute création de compte : `hub reconcile` compte déjà des
 * écarts hérités (stock). La batterie ne juge que ce qu'elle ajoute.
 */
import { cas, NonAbouti } from './lib/etat';
import { reconcile } from './lib/hub-admin';
import { noterReconcileBase } from './lib/monde';

cas(null, 'référence reconcile relevée avant les comptes de test', async () => {
  const r = await reconcile();
  if (!Array.isArray(r?.drifts)) throw new NonAbouti('reconcile sans liste de dérives : référence illisible');
  noterReconcileBase(r);
  return `${r.drifts.length} dérive(s) héritée(s), ${r.appsQueried ?? '?'} apps interrogées`;
});
