/** Une session Hub ouverte rebondit vers chaque app sans rien redemander, y compris en boucle. */
import { devraitEtreArrive } from './lib/assertions';
import type { AppKey } from './lib/cibles';
import { cas } from './lib/etat';
import { compte, contexteDe, ouvrirApp } from './lib/monde';

for (const app of ['prospection', 'notifuse', 'analytics'] as AppKey[]) {
  cas(app, 'la session Hub ouverte rebondit sans redemander', async ({ browser }) => {
    const A = await compte(browser, 'A');
    const ctx = await contexteDe(browser, A); // un seul contexte : la même session Hub sert deux fois
    try {
      const un = await ouvrirApp(ctx, app);
      devraitEtreArrive(un, app);
      const deux = await ouvrirApp(ctx, app);
      devraitEtreArrive(deux, app);
      return `2 rebonds sans saisie, fin sur ${deux.hote}${deux.chemin}`;
    } finally {
      await ctx.close();
    }
  });
}
