/**
 * Un compte sans adresse prouvée n'arrive pas dans l'app. Scénario d'attaque : inscription
 * publique avec un mot de passe, sur une adresse jamais confirmée. Le témoin positif
 * (le compte prouvé de 01 entre bien) doit exister, sinon l'absence ne prouve rien.
 */
import { devraitNePasEtreArrive } from './lib/assertions';
import { type AppKey } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { impersonate, lookup } from './lib/hub-admin';
import { compte, contexteDe, memoArrivee, ouvrirApp } from './lib/monde';

for (const app of ['prospection', 'notifuse', 'analytics'] as AppKey[]) {
  cas(app, 'un compte sans adresse prouvée n\'y arrive pas', async ({ browser }) => {
    // Témoin positif : le compte prouvé a franchi la porte de preuve du Hub, soit en arrivant
    // dans l'app, soit en allant jusqu'à l'émission du lien (page d'échec du rebond : le Hub a
    // appelé l'app, qui ne répond pas). Un compte non prouvé doit, lui, s'arrêter AVANT.
    const temoin = memoArrivee(app);
    const hubAEmis = !!temoin && (temoin.ok || /bounce\/error/.test(temoin.atterrissage.chemin));
    if (!hubAEmis) {
      throw new NonAbouti(`témoin positif absent : le compte prouvé n'est ni arrivé dans ${app} ni allé jusqu'à l'émission du lien (cas 01 : ${temoin ? temoin.atterrissage.hote + temoin.atterrissage.chemin : 'non joué'})`);
    }
    const NP = await compte(browser, 'NP');
    const avant = (await lookup(NP.email)).json;
    let voie = 'mot de passe';
    let ctx;
    if (NP.etat) {
      ctx = await contexteDe(browser, NP);
    } else {
      // Le Hub a refusé la session par mot de passe : on rejoue par une session posée par l'admin.
      voie = 'session posée par impersonation';
      const lien = (await impersonate(NP.email)).links.hub;
      ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(lien, { waitUntil: 'networkidle' });
    }
    try {
      const a = await ouvrirApp(ctx, app);
      devraitNePasEtreArrive(a, app);
      if (/bounce\/error/.test(a.chemin)) {
        throw new Error(`${app} : le Hub a tenté d'émettre un lien pour un compte sans adresse prouvée (fin sur ${a.chemin}) : la porte de preuve n'a pas arrêté le rebond`);
      }
      const apres = (await lookup(NP.email)).json;
      if (apres?.user?.email_verified) throw new Error('le parcours a prouvé l\'adresse à la place du propriétaire');
      void avant;
      return `refus (${voie}) : fin sur ${a.hote}${a.chemin}`;
    } finally {
      await ctx.close();
    }
  });
}
