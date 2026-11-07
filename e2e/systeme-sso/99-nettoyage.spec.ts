/**
 * Nettoyage : uniquement les comptes notés par CETTE batterie (registre `.run/comptes.jsonl`,
 * préfixe e2e-sso-, domaine veridian.site). Mécanisme prévu : suppression de tenant au Hub
 * (qui pousse la suppression aux apps) + suppression du workspace Notifuse. On vérifie ensuite
 * que les comptes ont disparu du Hub et que reconcile n'a rien gardé d'eux.
 */
import { expect } from '@playwright/test';

import { cas } from './lib/etat';
import { lookup, reconcile, rybbitCompte, supprimerNotifuse, supprimerTenantHub } from './lib/hub-admin';
import { comptesRybbit } from './lib/monde';
import { comptesNotes, oublierRegistre } from './lib/parcours';

cas(null, 'les comptes de test sont supprimés et reconcile n\'en garde aucun', async () => {
  const emails = Array.from(new Set(comptesNotes()));
  const restes: string[] = [];
  for (const e of comptesRybbit()) rybbitCompte('supprimer', e); // échec = NON ABOUTI, jamais un faux vert
  for (const email of emails) {
    const u = await lookup(email);
    for (const t of (u.json?.tenants ?? []) as any[]) {
      if (t.notifuseWorkspaceSlug) await supprimerNotifuse(t.id);
    }
    await supprimerTenantHub(email);
    if ((await lookup(email)).status !== 404) restes.push(email);
  }
  expect(restes, 'comptes encore présents au Hub après suppression').toEqual([]);
  const r = await reconcile();
  const flat = JSON.stringify(r).toLowerCase();
  const gardes = emails.filter((e) => flat.includes(e.toLowerCase()));
  expect(gardes, 'comptes de test encore cités par reconcile').toEqual([]);
  oublierRegistre();
  return `${emails.length} compte(s) supprimé(s)`;
});
