/**
 * Un abonnement Stripe fait monter le plan du CRM d'un compte dont le Hub a créé l'espace.
 *
 * C'est le chemin où le premier abonné serait tombé avant le 22/11 : la création d'espace posait un
 * `free` en `plan_source=grant_manual`, donc « offert », immunisé contre Stripe (CONTRAT-BILLING §3.4).
 * Le CRM restait en free, sans erreur. Désormais la création ne pose aucun plan.
 *
 * Joué sur le Hub de STAGING seulement (clés Stripe de test) : `HUB_URL=https://hub.staging.veridian.site`.
 * L'événement Stripe est réel (abonnement créé par l'API Stripe de test). Il est remis au webhook du Hub,
 * signé avec le secret du webhook, parce que le point d'arrivée Stripe du staging est désactivé : le
 * staging dort (scale-to-zero) et sa page de réveil répond 200 à Stripe.
 *
 * Épreuve : `SSO_SABOTAGE=stripe-sans-webhook` ne remet pas l'événement au Hub : le cas doit échouer
 * (le plan ne monte que par Stripe). L'ancien défaut, un free posé en grant_manual, est corrigé des deux
 * côtés (Hub `estPlanOffert`, Twenty `decidePlanUpdate`) : il ne bloque plus, `stripe-free-offert` passe.
 */
import { createHmac } from 'node:crypto';

import { devraitAvoirPlan } from './lib/assertions';
import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, lookup, planDansApp, planHub, secretDe } from './lib/hub-admin';
import { compte, contexteDe } from './lib/monde';
import { noterEspaceTwenty } from './lib/parcours';

const STRIPE = 'https://api.stripe.com/v1';

function cleStripeTest(): string {
  const cle = secretDe('STRIPE_SECRET_KEY_TEST');
  if (!cle.startsWith('sk_test_')) throw new NonAbouti('STRIPE_SECRET_KEY_TEST n\'est pas une clé de test : cas non joué');
  return cle;
}

async function stripe<T = any>(methode: 'GET' | 'POST' | 'DELETE', chemin: string, params: Record<string, string> = {}): Promise<T> {
  const corps = new URLSearchParams(params).toString();
  const url = methode === 'GET' && corps ? `${STRIPE}${chemin}?${corps}` : `${STRIPE}${chemin}`;
  const r = await fetch(url, {
    method: methode,
    headers: {
      Authorization: `Bearer ${cleStripeTest()}`,
      ...(methode === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: methode === 'POST' ? corps : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => null)) as any;
  if (!r.ok) throw new NonAbouti(`Stripe ${methode} ${chemin} : HTTP ${r.status} ${j?.error?.message ?? ''}`.slice(0, 200));
  return j as T;
}

/** Plan lu chez Twenty, à plat (la découverte rend un plan par espace). */
const planTwenty = async (email: string, hubUserId: string) => {
  const p = await planDansApp('twenty', email, hubUserId);
  return p && p.length === 1 ? p[0] : p;
};

async function attendre<T>(lire: () => Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const fin = Date.now() + ms;
  let v = await lire();
  while (!ok(v) && Date.now() < fin) {
    await new Promise((r) => setTimeout(r, 3_000));
    v = await lire();
  }
  return v;
}

/** Remet l'événement Stripe au webhook du Hub, signé comme Stripe le signe (`t=…,v1=HMAC(t.corps)`). */
async function remettreAuHub(evenement: unknown): Promise<number> {
  const corps = JSON.stringify(evenement);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secretDe('STRIPE_WEBHOOK_SECRET_TEST')).update(`${t}.${corps}`).digest('hex');
  const r = await fetch(`${HUB_URL}/api/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` },
    body: corps,
    signal: AbortSignal.timeout(60_000),
  });
  return r.status;
}

cas('twenty', 'un abonnement Stripe fait passer le CRM du free au plan payé', async ({ browser }) => {
  if (!/staging/.test(HUB_URL)) throw new NonAbouti('cas joué sur le Hub de staging seulement (clés Stripe de test)');
  const sante = await fetch(`${APP_URL.twenty}/healthz`, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!sante || sante.status >= 400) throw new NonAbouti(`Twenty non servi (${APP_URL.twenty}) : cas non joué`);

  const S = await compte(browser, 'S');
  if (!S.hubUserId) throw new NonAbouti('compte de test sans hub_user_id');

  // 1. L'espace naît par le Hub (qui crée le tenant s'il manque, cas du staging sans Notifuse ni
  // Prospection), sans plan_source : Twenty le garde en free, le Hub n'invente rien.
  await activerTwentyAuHub(S.email);
  const tenantId: string | undefined = (await lookup(S.email)).json?.tenants?.[0]?.id;
  if (!tenantId) throw new Error('aucun tenant Hub après l\'activation du CRM');
  noterEspaceTwenty(S.email, tenantId); // retiré au nettoyage, même si la suite plante
  devraitAvoirPlan(await planTwenty(S.email, S.hubUserId), 'free', 'Twenty juste après la création de l\'espace');
  const meta = (await lookup(S.email)).json?.tenants?.[0]?.metadata ?? {};
  if (meta.crm_plan_source) throw new Error(`le Hub a posé un plan_source à la création : ${meta.crm_plan}/${meta.crm_plan_source}`);

  // Ancien défaut rejoué : un free posé comme plan offert avant l'abonnement. Il ne doit plus bloquer.
  if (process.env.SSO_SABOTAGE === 'stripe-free-offert') await planHub(tenantId, 'crm', 'free');

  // 3. Abonnement Stripe de test au bundle Veridian Pro, avec la carte de test qui passe.
  const produits = await stripe('GET', '/products/search', { query: "metadata['veridian_plan']:'veridian-pro' AND active:'true'" });
  const produit = produits.data?.[0];
  const prix = produit?.default_price ?? (await stripe('GET', '/prices', { product: produit?.id ?? '', active: 'true', limit: '1' })).data?.[0]?.id;
  if (!prix) throw new NonAbouti('aucun prix Stripe de test pour veridian-pro');
  const client = await stripe('POST', '/customers', { email: S.email, name: S.nom, 'metadata[userUuid]': S.hubUserId });
  let abonnement: any = null;
  try {
    await stripe('POST', '/payment_methods/pm_card_visa/attach', { customer: client.id });
    const cartes = await stripe('GET', '/payment_methods', { customer: client.id, type: 'card', limit: '1' });
    abonnement = await stripe('POST', '/subscriptions', {
      customer: client.id,
      'items[0][price]': typeof prix === 'string' ? prix : prix.id,
      default_payment_method: cartes.data[0].id,
      trial_end: 'now',
      'metadata[plan_key]': 'veridian-pro',
    });
    if (abonnement.status !== 'active') throw new NonAbouti(`abonnement Stripe ${abonnement.status}, pas active`);

    // 4. L'événement réel, remis au webhook du Hub.
    const evts = await attendre(
      () => stripe('GET', '/events', { type: 'customer.subscription.created', limit: '20' }),
      (e: any) => e.data?.some((x: any) => x.data?.object?.id === abonnement.id),
      30_000,
    );
    const evenement = evts.data.find((x: any) => x.data?.object?.id === abonnement.id);
    if (!evenement) throw new NonAbouti('événement customer.subscription.created introuvable chez Stripe');
    if (process.env.SSO_SABOTAGE !== 'stripe-sans-webhook') {
      const statut = await remettreAuHub(evenement);
      if (statut !== 200) throw new Error(`webhook du Hub : HTTP ${statut}`);
    }

    // 5. Le CRM suit : pro chez Twenty, pro/stripe au Hub.
    const plan = await attendre(() => planTwenty(S.email, S.hubUserId!), (p) => p === 'pro');
    devraitAvoirPlan(plan, 'pro', 'Twenty après l\'abonnement Stripe veridian-pro');
    const apres = (await lookup(S.email)).json?.tenants?.[0]?.metadata ?? {};
    if (apres.crm_plan !== 'pro' || apres.crm_plan_source !== 'stripe') {
      throw new Error(`Hub après l'abonnement : ${apres.crm_plan}/${apres.crm_plan_source}, attendu pro/stripe`);
    }
    return `free à la création, pro/stripe après l'abonnement ${abonnement.id} (Twenty et Hub)`;
  } finally {
    if (abonnement?.id) await stripe('DELETE', `/subscriptions/${abonnement.id}`).catch(() => undefined);
    await stripe('DELETE', `/customers/${client.id}`).catch(() => undefined);
  }
}, { timeout: 420_000 });

cas('twenty', 'un espace créé sans plan_source s\'ouvre par le rebond, se lit et s\'écrit', async ({ browser }) => {
  if (!/staging/.test(HUB_URL)) throw new NonAbouti('cas joué sur le Hub de staging seulement');
  const S = await compte(browser, 'S');
  const meta = (await lookup(S.email)).json?.tenants?.[0]?.metadata ?? {};
  if (!meta.crm) {
    await activerTwentyAuHub(S.email);
    const tenantId: string | undefined = (await lookup(S.email)).json?.tenants?.[0]?.id;
    if (tenantId) noterEspaceTwenty(S.email, tenantId);
  }
  const ctx = await contexteDe(browser, S);
  try {
    // Une seule page suit le rebond jusqu'à l'espace : `/verify?loginToken=` est à usage unique.
    const page = await ctx.newPage();
    await page.goto(`${APP_URL.twenty}/settings/profile`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    const fin = Date.now() + 90_000;
    let vue = page.url();
    let depuis = Date.now();
    while (Date.now() < fin && (Date.now() - depuis < 15_000 || new URL(page.url()).pathname === '/verify')) {
      await page.waitForTimeout(500);
      if (page.url() !== vue) {
        vue = page.url();
        depuis = Date.now();
      }
    }
    if (!new URL(page.url()).host.includes('.crm.')) throw new Error(`Twenty : le rebond n'arrive pas dans l'espace (${new URL(page.url()).host}${new URL(page.url()).pathname})`);
    // Même lecture de session que la batterie (`sessionLue`) : cookie de session du fork.
    const gql = (chemin: string, query: string) =>
      page.evaluate(
        async ([c, q]) => {
          const r = await fetch(c as string, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-twenty-session-cookie': '1' },
            body: JSON.stringify({ query: q }),
          });
          return { status: r.status, corps: (await r.json().catch(() => null)) as any };
        },
        [chemin, query],
      );
    const moi = await gql('/metadata', '{currentUser{email}}');
    if (moi.corps?.data?.currentUser?.email !== S.email) {
      const cles = await page.evaluate(() => Object.keys(localStorage)).catch(() => []);
      const tous = (await ctx.cookies()).map((c) => `${c.name}@${c.domain}`).join(', ');
      throw new Error(`Twenty : session absente sur ${new URL(page.url()).host}${new URL(page.url()).pathname} (${moi.status}) ; cookies : ${tous} ; localStorage : ${cles.join(', ')}`);
    }
    const cree = await gql('/graphql', 'mutation{createCompany(data:{name:"E2E plan Stripe"}){id name}}');
    const id = cree.corps?.data?.createCompany?.id;
    if (!id) throw new Error(`Twenty : écriture refusée (${cree.status}, ${JSON.stringify(cree.corps).slice(0, 160)})`);
    const lu = await gql('/graphql', `{company(filter:{id:{eq:"${id}"}}){name}}`);
    if (lu.corps?.data?.company?.name !== 'E2E plan Stripe') throw new Error('Twenty : relecture de la société écrite impossible');
    await gql('/graphql', `mutation{destroyCompany(id:"${id}"){id}}`);
  } finally {
    await ctx.close();
  }

  return 'session ouverte par le rebond, société écrite, relue puis effacée';
}, { timeout: 300_000 });
