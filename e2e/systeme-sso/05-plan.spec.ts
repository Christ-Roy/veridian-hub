/** Le changement de plan posé au Hub se retrouve dans l'app (dans les deux sens). */
import { devraitAvoirPlan } from './lib/assertions';
import { APP_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerAnalyticsAuHub, activerTwentyAuHub, planDansApp, planHub, statutNotifuse } from './lib/hub-admin';
import { assurerRybbit, compte, contexteDe, ouvrirApp } from './lib/monde';
import { espacesTwenty, noterEspaceTwenty } from './lib/parcours';

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

/**
 * Analytics et Twenty : le Hub pose le plan (`hub plan --app analytics|crm`), l'app le stocke sans rien
 * limiter, et sa découverte le rend (ce que compare `hub reconcile`). Dans les deux sens.
 * Épreuve : `SSO_SABOTAGE=plan-analytics|plan-twenty` retire la poussée du Hub, le cas doit échouer.
 */
const sabote = (s: string) => process.env.SSO_SABOTAGE === s;

async function sensAllerRetour(
  app: 'analytics' | 'twenty',
  tenantId: string,
  lire: () => Promise<string[] | null>,
): Promise<string> {
  const appHub = app === 'twenty' ? 'crm' : 'analytics';
  for (const plan of ['business', 'free']) {
    if (!sabote(`plan-${app}`)) await planHub(tenantId, appHub, plan);
    const lu = await attendre(lire, (p) => !!p?.includes(plan));
    if (lu === null) throw new Error(`${app} : la découverte ne connaît pas le compte`);
    devraitAvoirPlan(lu.length === 1 ? lu[0] : lu, plan, `${app} après passage au plan ${plan}`);
  }
  return 'business puis free relus dans la découverte de l\'app';
}

cas('analytics', 'le plan posé au Hub se retrouve dans l\'app', async ({ browser }) => {
  const A = await compte(browser, 'A');
  assurerRybbit(A);
  const ctx = await contexteDe(browser, A);
  try {
    await ouvrirApp(ctx, 'analytics'); // premier rebond : relie le compte Rybbit par hub_user_id
  } finally {
    await ctx.close();
  }
  await activerAnalyticsAuHub(A.email);
  return sensAllerRetour('analytics', A.tenantId!, () => planDansApp('analytics', A.email, A.hubUserId));
});

cas('twenty', 'le plan posé au Hub se retrouve dans l\'app', async ({ browser }) => {
  const sante = await fetch(`${APP_URL.twenty}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!sante || sante.status >= 400) throw new NonAbouti(`Twenty non servi (${APP_URL.twenty}) : cas non joué`);
  const A = await compte(browser, 'A');
  if (!A.tenantId) throw new NonAbouti('compte de test sans tenant Hub');
  if (!espacesTwenty(A.email).length) {
    noterEspaceTwenty(A.email, A.tenantId); // noté AVANT la création : un plantage ne doit rien laisser
    await activerTwentyAuHub(A.email);
  }
  return sensAllerRetour('twenty', A.tenantId, () => planDansApp('twenty', A.email, A.hubUserId));
});
