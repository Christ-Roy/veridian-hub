/**
 * Un client dont l'adresse n'est pas prouvée au Hub, avec un compte Analytics non relié (les trois clients
 * du 08/11 : alice, sirpepeinture, vert.g.bio) : il ouvre Analytics, le Hub l'arrête et lui envoie la
 * preuve, il la confirme dans le vrai mail, puis il arrive connecté sur Rybbit, son compte relié.
 * Aucun mail de plomberie n'est envoyé aux clients : ils se relient ainsi seuls, à leur prochaine visite.
 * Épreuve : `SSO_SABOTAGE=preuve` saute la confirmation, l'arrivée doit échouer.
 */
import { expect } from '@playwright/test';

import { devraitEtreArrive, devraitNePasEtreArrive } from './lib/assertions';
import { HUB_URL } from './lib/cibles';
import { ADRESSE_PREUVE, lienDePreuve } from './lib/boite';
import { cas, NonAbouti } from './lib/etat';
import { lookup, planDansApp } from './lib/hub-admin';
import { assurerRybbit, contexteDe, ouvrirApp } from './lib/monde';
import { creerCompteNonProuve } from './lib/parcours';

cas('analytics', 'adresse non prouvée : la preuve reçue par mail puis confirmée relie et connecte sur Rybbit', async ({ browser }) => {
  const depuis = new Date();
  const P = await creerCompteNonProuve(browser, 'preuve', ADRESSE_PREUVE);
  if (!P.etat) throw new NonAbouti('le Hub n\'a pas ouvert de session par mot de passe au compte non prouvé');
  assurerRybbit(P); // son compte Analytics existe, non relié : comme les trois clients
  const ctx = await contexteDe(browser, P);
  try {
    const avant = await ouvrirApp(ctx, 'analytics');
    devraitNePasEtreArrive(avant, 'analytics');
    const lien = await lienDePreuve(ADRESSE_PREUVE, depuis);
    if (process.env.SSO_SABOTAGE !== 'preuve') {
      const page = await ctx.newPage();
      await page.goto(lien, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Confirmer mon adresse' }).click();
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await page.close();
    }
    const u = (await lookup(ADRESSE_PREUVE)).json;
    expect(u?.user?.email_verified, 'adresse prouvée au Hub après la confirmation').toBeTruthy();
    const apres = await ouvrirApp(ctx, 'analytics');
    devraitEtreArrive(apres, 'analytics');
    // Relié : Rybbit le retrouve par son hub_user_id, sans l'adresse.
    const relie = await planDansApp('analytics', 'absent@invalid.example', u.user.supabase_user_id);
    expect(relie, 'compte Rybbit relié au compte Hub (trouvé par hub_user_id)').not.toBeNull();
    return `refus avant preuve (${avant.chemin}), lien reçu par mail, confirmé, arrivée sur ${apres.hote}${apres.chemin}, relié`;
  } finally {
    await ctx.close();
  }
});
