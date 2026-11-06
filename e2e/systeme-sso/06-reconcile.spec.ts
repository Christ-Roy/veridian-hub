/** `hub reconcile` ne compte aucune dérive nouvelle après le passage de la batterie. */
import { devraitNeVoirAucuneDeriveNouvelle } from './lib/assertions';
import { cas, NonAbouti } from './lib/etat';
import { reconcile } from './lib/hub-admin';
import { comptesCrees, reconcileBase } from './lib/monde';

cas(null, 'reconcile ne compte aucune dérive nouvelle après le passage', async () => {
  const base = reconcileBase();
  if (!base) throw new NonAbouti('référence reconcile absente (00-reference non jouée)');
  const apres = await reconcile();
  const mesures: string[] = [];
  for (const [app, bloc] of Object.entries<any>(apres.identity ?? {})) {
    mesures.push(`${app}=${bloc.status}`);
  }
  devraitNeVoirAucuneDeriveNouvelle(base, apres);
  // aucun de nos comptes ne figure dans une liste d'identité, même si le statut est « ok »
  const flat = JSON.stringify(apres.identity ?? {}).toLowerCase();
  for (const c of comptesCrees()) {
    if (flat.includes(c.email.toLowerCase())) throw new Error(`reconcile signale le compte de test ${c.etiquette} dans l'audit d'identité`);
  }
  const nonMesures = Object.entries<any>(apres.identity ?? {}).filter(([, b]) => b.status !== 'ok');
  if (nonMesures.length) {
    throw new NonAbouti(
      `dérives de tenants : aucune nouvelle ; mais l'audit d'identité n'a pas pu mesurer ${nonMesures
        .map(([a, b]) => `${a} (${b.status})`)
        .join(', ')}`,
    );
  }
  return `aucune dérive nouvelle (${(apres.drifts ?? []).length} héritées) ; identité ${mesures.join(' ')}`;
});
