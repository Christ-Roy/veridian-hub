/**
 * L'ancien changement d'adresse (réglages, « Votre email »), même garde que la promotion : fermé à qui a un compte chez Mail, au CRM ou chez Academy, qui
 * désignent encore quelqu'un par son adresse ; la personne lit pourquoi, et son adresse actuelle marche toujours. Sans eux, il passe.
 * Épreuves : `SSO_SABOTAGE=email-refuse` (un compte sans ces apps à la place du refusé) et `email-passe` (un compte chez Mail à la place de celui qui
 * passe) doivent faire échouer le cas. Aucun mail réel : adresses de batterie, bac à sable Brevo.
 */
import { expect, type BrowserContext } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, adminOk, lookup } from './lib/hub-admin';
import { adresseDe, attendreSessionHub, connexionHub, creerCompteProuve, noter, noterEspaceTwenty, ouvrirApp, type Compte } from './lib/parcours';

cas(null, 'réglages : l\'adresse ne change pas chez Mail, au CRM ou chez Academy, et passe sans eux', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('le Hub de staging n\'a ni Mail ni Academy en face');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const M: Compte = await creerCompteProuve(browser, 'chgmail');
  const C: Compte = await creerCompteProuve(browser, 'chgcrm', undefined, true);
  const K: Compte = await creerCompteProuve(browser, 'chgaca', undefined, true);
  const D: Compte = await creerCompteProuve(browser, 'chgsans', undefined, true);
  await activerTwentyAuHub(C.email);
  const tc = (await lookup(C.email)).json?.tenants?.[0];
  if (!tc) throw new NonAbouti('compte CRM sans tenant');
  noterEspaceTwenty(C.email, tc.id);
  await adminOk('POST', 'tenants/app-access', { user_email: K.email, app: 'academy', enabled: true });

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

  const refusee = sabotage === 'email-refuse' ? D : M;
  const m = await changer(refusee, 'chgmail2');
  expect([m.statut, m.apps, m.sousNeuve, m.sousActuelle], `Mail : ${m.lu}`).toEqual([409, ['notifuse'], null, M.hubUserId]);
  expect(m.lu).toMatch(/^Mail vous reconnaît encore par votre adresse.*votre adresse actuelle continue de marcher partout/);
  const c = await changer(C, 'chgcrm2');
  expect([c.statut, c.apps, c.sousNeuve, c.sousActuelle], `CRM : ${c.lu}`).toEqual([409, ['crm'], null, C.hubUserId]);
  const k = await changer(K, 'chgaca2');
  expect([k.statut, k.apps, k.sousNeuve, k.sousActuelle], `Academy : ${k.lu}`).toEqual([409, ['academy'], null, K.hubUserId]);

  // Ce qu'on lui dit est vrai : elle se reconnecte avec son adresse, et entre dans Mail.
  await avec(null, async (ctx) => {
    await connexionHub(await ctx.newPage(), M.email, M.motDePasse);
    expect(await attendreSessionHub(ctx, M.email), 'son adresse actuelle marche toujours').toBe(true);
    const a = await ouvrirApp(ctx, 'notifuse');
    expect([a.hote, a.formulaireMotDePasse], `Mail : ${a.url}`).toEqual(['notifuse.app.veridian.site', false]);
  });

  const libre = sabotage === 'email-passe' ? M : D;
  const d = await changer(libre, 'chgsans2');
  expect([d.statut, d.sousNeuve, d.sousActuelle], `sans Mail, CRM ni Academy : ${d.lu}`).toEqual([200, D.hubUserId, null]);
  return 'à l\'écran : refusée chez Mail, au CRM, chez Academy, l\'app nommée, rien n\'a changé, l\'adresse actuelle entre toujours (Hub et Mail) ; sans eux : changée, même personne';
}, { timeout: 900_000 });
