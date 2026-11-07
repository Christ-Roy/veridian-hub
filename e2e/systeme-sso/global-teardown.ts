/**
 * Filet de sécurité : si la batterie a planté avant `99-nettoyage`, les comptes notés au
 * registre sont tout de même supprimés. Ne touche QUE les comptes de ce registre.
 */
import { lookup, rybbitCompte, supprimerNotifuse, supprimerTenantHub } from './lib/hub-admin';
import { comptesRybbit } from './lib/monde';
import { comptesNotes, oublierRegistre } from './lib/parcours';

export default async function () {
  const restes = Array.from(new Set(comptesNotes()));
  for (const e of comptesRybbit()) {
    try {
      rybbitCompte('supprimer', e);
    } catch (err) {
      console.log(`[nettoyage de secours] compte Rybbit ${e} NON supprimé : ${(err as Error).message}`);
      return;
    }
  }
  for (const email of restes) {
    try {
      const u = await lookup(email);
      if (u.status === 404) continue;
      for (const t of (u.json?.tenants ?? []) as any[]) if (t.notifuseWorkspaceSlug) await supprimerNotifuse(t.id);
      await supprimerTenantHub(email);
      console.log(`[nettoyage de secours] ${email} supprimé`);
    } catch (e) {
      console.log(`[nettoyage de secours] ${email} NON supprimé : ${(e as Error).message}`);
      return; // on garde le registre pour la prochaine passe
    }
  }
  oublierRegistre();
}
