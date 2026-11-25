/**
 * L'ancien changement d'adresse (réglages, « Votre email »), même garde que la promotion, PAR COMPTE (parente, 25/11) : relié chez Mail et au CRM, il
 * passe ; un compte que l'app ne connaît que par son adresse (ici Mail, et Analytics) est refusé, et lit pourquoi ; Academy, qui désigne encore par
 * l'adresse, reste fermée. L'adresse actuelle d'un refusé marche toujours. NON JOUÉ en prod : une app muette (tests).
 * Épreuves : `SSO_SABOTAGE=email-refuse` (un compte relié à la place du non relié) et `email-passe` (un compte non relié à la place de celui qui passe)
 * doivent faire échouer le cas. Aucun mail réel : adresses de batterie, bac à sable Brevo.
 */
import { createHmac } from 'node:crypto';

import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, adminOk, lookup, rybbitCompte, secretDe } from './lib/hub-admin';
import { adresseDe, attendreSessionHub, connexionHub, creerCompteProuve, ID_RUN, noter, noterEspaceTwenty, noterRybbit, noterWorkspace, type Compte } from './lib/parcours';

cas(null, 'réglages : l\'adresse change si chaque app suit la personne, et pas sinon', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('le Hub de staging n\'a ni Mail ni Academy en face');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const M: Compte = await creerCompteProuve(browser, 'chgmail');
  const compte = (e: string) => creerCompteProuve(browser, e, undefined, true);
  const [K, U, V]: Compte[] = [await compte('chgaca'), await compte('chgryb'), await compte('chgnl')];
  // M : reliée chez Mail, Prospection (inscription) et au CRM.
  await activerTwentyAuHub(M.email);
  noterEspaceTwenty(M.email, M.tenantId!);
  await adminOk('POST', 'tenants/app-access', { user_email: K.email, app: 'academy', enabled: true });
  // U : un compte Analytics, V : un espace Mail, qui ne les connaissent que par leur adresse.
  noterRybbit(U.email);
  rybbitCompte('creer', U.email);
  const ws = `e2esso${ID_RUN}`.replace(/[^a-z0-9]/g, '').slice(0, 18) + 'nl';
  noterWorkspace(V.email, ws);
  const signer = (chemin: string, corps: string, get = false) => { const ts = String(Date.now()); return fetch(`${APP_URL.notifuse}${chemin}`, { method: get ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'X-Veridian-Timestamp': ts, 'X-Veridian-Hub-Signature': createHmac('sha256', secretDe('NOTIFUSE_HUB_API_SECRET')).update(`${ts}.${corps}`).digest('hex') }, ...(get ? {} : { body: corps }), signal: AbortSignal.timeout(60_000) }); };
  const cree = await signer('/api/tenants/provision', JSON.stringify({ tenant_id: ws, owner_email: V.email, workspace_name: 'TEST non relié', plan: 'free' }));
  if (!cree.ok) throw new NonAbouti(`espace Mail non relié : HTTP ${cree.status} ${(await cree.text()).slice(0, 160)}`);
  const copiesMail = async () => ((await (await signer('/api/hub/users', '', true)).json()) as { users: { hub_user_id: string | null; email: string }[] }).users;
  expect((await copiesMail()).filter((x) => x.email.toLowerCase() === V.email.toLowerCase()).map((x) => x.hub_user_id), 'contrôle positif : Mail connaît V par sa seule adresse').toEqual([null]);

  const avec = async <R>(etat: unknown, f: (ctx: BrowserContext) => Promise<R>): Promise<R> => {
    const ctx = await browser.newContext(etat ? { storageState: etat as never } : {});
    ctx.setDefaultTimeout(45_000);
    try { return await f(ctx); } finally { await ctx.close(); }
  };
  /** Le geste, à l'écran : ce qu'il lit, ce que le serveur a répondu, et la personne relue au Hub sous chaque adresse. */
  const changer = async (c: Compte, etiquette: string) => {
    const neuve = adresseDe(etiquette).toLowerCase();
    noter(neuve);
    const r = await avec(c.etat, async (ctx) => {
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
      await page.getByPlaceholder('Votre email').fill(neuve);
      const [rep] = await Promise.all([page.waitForResponse((x) => x.url().endsWith('/api/account/profile') && x.request().method() === 'PATCH'), page.getByRole('button', { name: 'Mettre à jour l\'email' }).click()]);
      const dit = rep.ok() ? page.getByText('Email mis à jour') : page.getByRole('alert').filter({ hasText: 'continue de marcher' });
      await dit.first().waitFor();
      return { statut: rep.status(), apps: ((await rep.json().catch(() => null)) as { apps?: string[] } | null)?.apps?.slice().sort() ?? [], lu: await dit.first().innerText() };
    });
    return { ...r, sousNeuve: (await lookup(neuve)).json?.user?.supabase_user_id ?? null, sousActuelle: (await lookup(c.email)).json?.user?.supabase_user_id ?? null };
  };

  const v = await changer(sabotage === 'email-refuse' ? M : V, 'chgnl2');
  expect([v.statut, v.apps, v.sousNeuve, v.sousActuelle], `Mail non relié : ${v.lu}`).toEqual([409, ['notifuse'], null, V.hubUserId]);
  expect(v.lu).toMatch(/^Mail ne vous connaît que par votre adresse actuelle.*continue de marcher partout/);
  const u = await changer(U, 'chgryb2');
  expect([u.statut, u.apps, u.sousNeuve, u.sousActuelle], `Analytics non relié : ${u.lu}`).toEqual([409, ['analytics'], null, U.hubUserId]);
  const k = await changer(K, 'chgaca2');
  expect([k.statut, k.apps, k.sousNeuve, k.sousActuelle], `Academy : ${k.lu}`).toEqual([409, ['academy'], null, K.hubUserId]);
  // Ce qu'on lui dit est vrai.
  await avec(null, async (ctx) => {
    await connexionHub(await ctx.newPage(), V.email, V.motDePasse);
    expect(await attendreSessionHub(ctx, V.email), 'son adresse actuelle marche toujours').toBe(true);
  });

  const m = await changer(sabotage === 'email-passe' ? U : M, 'chgmail2');
  expect([m.statut, m.sousNeuve, m.sousActuelle], `reliée chez Mail et au CRM : ${m.lu}`).toEqual([200, M.hubUserId, null]);
  expect((await copiesMail()).filter((x) => x.hub_user_id === M.hubUserId).length, 'une seule personne chez Mail').toBe(1);
  return 'à l\'écran : reliée chez Mail, au CRM et chez Prospection, elle change et reste une seule personne ; connue de Mail ou d\'Analytics par sa seule adresse : refusée, l\'app nommée, l\'adresse actuelle marche ; Academy : fermée. App muette : tests seulement';
}, { timeout: 900_000 });
