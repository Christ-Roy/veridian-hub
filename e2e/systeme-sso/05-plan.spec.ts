/** Le changement de plan posé au Hub se retrouve dans l'app (dans les deux sens). */
import { devraitAvoirPlan } from './lib/assertions';
import { APP_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { planHub, statutNotifuse } from './lib/hub-admin';
import { compte, contexteDe, ouvrirApp } from './lib/monde';

async function attendre<T>(lire: () => Promise<T>, ok: (v: T) => boolean, ms = 40_000): Promise<T> {
  const fin = Date.now() + ms;
  let v = await lire();
  while (!ok(v) && Date.now() < fin) {
    await new Promise((r) => setTimeout(r, 2_000));
    v = await lire();
  }
  return v;
}

cas('prospection', 'le plan posé au Hub se retrouve dans l\'app', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const ctx = await contexteDe(browser, A);
  try {
    await ouvrirApp(ctx, 'prospection'); // pose la session Prospection
    const lire = async () =>
      (await (await ctx.request.get(`${APP_URL.prospection}/api/trial`)).json()) as { plan?: string; daysLeft?: number };
    await planHub(A.tenantId!, 'prospection', 'pro');
    const pro = await attendre(lire, (t) => t.plan === 'pro');
    devraitAvoirPlan(pro.plan, 'pro', 'Prospection après passage au plan pro');
    await planHub(A.tenantId!, 'prospection', 'freemium'); // sens inverse : le témoin que la valeur bouge
    const retour = await attendre(lire, (t) => t.plan === 'freemium');
    devraitAvoirPlan(retour.plan, 'freemium', 'Prospection après retour en freemium');
    return 'pro puis freemium suivis dans /api/trial';
  } finally {
    await ctx.close();
  }
});

cas('notifuse', 'le plan posé au Hub se retrouve dans l\'app', async ({ browser }) => {
  const A = await compte(browser, 'A');
  const lire = async () => (await statutNotifuse(A.tenantId!)).plan; // statut lu CHEZ Notifuse (appel HMAC du Hub)
  await planHub(A.tenantId!, 'notifuse', 'pro');
  devraitAvoirPlan(await attendre(lire, (p) => p === 'pro'), 'pro', 'Notifuse après passage au plan pro');
  await planHub(A.tenantId!, 'notifuse', 'free');
  devraitAvoirPlan(await attendre(lire, (p) => p === 'free'), 'free', 'Notifuse après retour en free');
  return 'pro puis free relus côté Notifuse';
});

for (const app of ['analytics', 'twenty'] as const) {
  cas(app, 'le plan posé au Hub se retrouve dans l\'app', async () => {
    throw new NonAbouti(`le Hub ne pose pas de plan ${app} (CLI et route : prospection et notifuse seulement), cas non mesurable`);
  });
}
