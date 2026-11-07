/**
 * La page d'arrivée du lien de preuve s'affiche dans un vrai navigateur et son bouton valide
 * l'adresse. Le 07/11, elle plantait au rendu (« Application error ») alors que `curl` y lisait
 * le texte du bouton : seul un navigateur le voit. Ces comptes n'ont pas de boîte mail : le
 * cas passe par un jeton inconnu, qui emprunte le même formulaire, puis le refus du serveur.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas } from './lib/etat';
import { compte, contexteDe } from './lib/monde';

cas(null, 'la page du lien de preuve s\'affiche, et un jeton faux ne prouve rien', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  try {
    const page = await ctx.newPage();
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await page.goto(`${HUB_URL}/auth/email-proof?token=jeton-de-test-inconnu`);
    const bouton = page.getByRole('button', { name: 'Confirmer mon adresse' });
    await expect(bouton, 'bouton visible, pas de page d\'erreur').toBeVisible();
    await expect(page.getByText('Application error')).toHaveCount(0);
    await bouton.click();
    await expect(page.getByText("Ce lien n'est plus valable")).toBeVisible();
    expect(erreurs, 'erreurs JavaScript sur la page').toEqual([]);
    return 'formulaire rendu, bouton cliqué, jeton faux refusé';
  } finally {
    await ctx.close();
  }
});
