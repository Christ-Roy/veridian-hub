/**
 * Plusieurs adresses par personne (VER-227 S1b) : tout ce qui REFUSE, sans qu'aucun mail ne parte (adresses déjà prises seulement). Une adresse non
 * prouvée n'a aucun droit ; une adresse prise répond comme une libre ; un code inventé n'ajoute rien ; l'adresse d'un autre reste à lui.
 * NON PROUVÉ, faute de boîte d'épreuve (lib/boite.ts) : le code lu dans une vraie boîte, donc l'ajout lui-même et ce qu'il ouvre.
 * Épreuve : `SSO_SABOTAGE=adresses` demande au nom du compte prouvé à la place du non prouvé : le cas doit échouer.
 */
import { expect, type APIRequestContext } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { creerCompteNonProuve, creerCompteProuve, type Compte } from './lib/parcours';

cas(null, 'plusieurs adresses : rien ne s\'ajoute sans preuve, et rien ne dit si une adresse existe', async ({ browser }) => {
  const A: Compte = await creerCompteProuve(browser, 'adra', undefined, true);
  const B: Compte = await creerCompteProuve(browser, 'adrb', undefined, true);
  const N: Compte = await creerCompteNonProuve(browser, 'adrn');
  if (!N.etat) throw new NonAbouti('le compte non prouvé n\'a pas ouvert de session');
  const avec = async <R>(c: Compte | null, f: (r: APIRequestContext) => Promise<R>): Promise<R> => {
    const ctx = await browser.newContext(c ? { storageState: c.etat as never } : {});
    try {
      return await f(ctx.request);
    } finally {
      await ctx.close();
    }
  };
  const geste = (c: Compte | null, corps: object) => avec(c, async (r) => {
    const x = await r.post(`${HUB_URL}/api/account/adresses`, { data: corps });
    return [x.status(), await x.json().catch(() => null)] as const;
  });
  const liste = (c: Compte) => avec(c, async (r) => (await (await r.get(`${HUB_URL}/api/account/adresses`)).json()) as { principale: string; secondaires: string[] });

  expect((await geste(null, { geste: 'demander', email: B.email }))[0], 'sans session').toBe(401);
  const non = process.env.SSO_SABOTAGE === 'adresses' ? A : N;
  expect(await geste(non, { geste: 'demander', email: B.email }), 'adresse non prouvée : aucun droit').toEqual([403, { error: 'email_not_verified' }]);

  // Prise comme principale par un autre, ou la sienne : même réponse qu'une libre, et aucun mail ne part.
  expect(await geste(A, { geste: 'demander', email: B.email.toUpperCase() }), 'celle d\'un autre').toEqual([200, { ok: true }]);
  expect(await geste(A, { geste: 'demander', email: A.email }), 'la sienne').toEqual([200, { ok: true }]);
  for (const code of ['000000', '123456', '999999']) expect(await geste(A, { geste: 'confirmer', email: B.email, code }), `code inventé ${code}`).toEqual([400, { error: 'code_invalide' }]);
  expect((await geste(A, { geste: 'confirmer', email: B.email, code: 'abc' }))[0], 'code mal formé').toBe(400);
  expect((await geste(A, { geste: 'detacher', email: B.email }))[0], 'détacher celle d\'un autre').toBe(404);
  expect((await geste(A, { geste: 'detacher', email: A.email }))[0], 'détacher sa principale').toBe(404);
  expect((await geste(A, { geste: 'demander', email: 'x@x.fr', user_id: B.hubUserId }))[0], 'champ de plus').toBe(400);
  expect([await liste(A), await liste(B)].map((l) => [l.principale.toLowerCase(), l.secondaires])).toEqual([[A.email.toLowerCase(), []], [B.email.toLowerCase(), []]]);

  // Débit par compte : le seul refus visible.
  let dernier = 200;
  for (let i = 0; i < 6 && dernier === 200; i++) [dernier] = await geste(A, { geste: 'demander', email: B.email });
  expect(dernier, 'débit').toBe(429);

  // L'écran le propose.
  const ctx = await browser.newContext({ storageState: B.etat as never });
  try {
    const page = await ctx.newPage();
    await page.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
    await expect(page.getByLabel('Ajouter une adresse')).toBeVisible();
  } finally {
    await ctx.close();
  }
  return 'sans session 401, non prouvée 403, prise ou sienne : réponse neutre, codes inventés refusés, rien ajouté, débit, écran ; NON PROUVÉ : le code lu dans une vraie boîte';
}, { timeout: 300_000 });
