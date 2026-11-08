/**
 * Adresse au Hub différente de celle de l'app, et une personne qui a plusieurs comptes Hub (08/11 :
 * Robert, connecté au Hub avec son adresse veridian.site, renvoyé sans un mot par Rybbit qui ne
 * connaissait que sa gmail). Comportement défini (CONTRAT-HUB §3.7) :
 *  - l'app joint par `hub_user_id` : un compte relié s'ouvre quelle que soit l'adresse au Hub ;
 *  - un compte d'app n'appartient qu'à UN compte Hub, le premier relié le garde ; un second compte
 *    Hub de la même personne lit « accès rattaché à un autre compte », jamais un retour muet ;
 *  - un compte Hub que l'app ne connaît pas lit « pas encore d'accès », avec son adresse.
 *
 * Mise en scène : E = son compte Hub habituel, F = son second compte Hub, dont l'adresse est celle
 * du compte Rybbit, relié à E (le geste du 08/11). B n'a aucun compte Rybbit.
 * Épreuve : `SSO_SABOTAGE=adresse-liee|conflit` (pas de liaison) et `inconnu` (B reçoit un compte)
 * doivent faire échouer leur cas ; la version du Hub d'avant (retour au tableau de bord) aussi.
 */
import { expect } from '@playwright/test';

import { devraitEtreArrive } from './lib/assertions';
import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { rybbitCompte } from './lib/hub-admin';
import { assurerRybbit, compte, contexteDe, ouvrirApp } from './lib/monde';
import type { Atterrissage } from './lib/parcours';
import { devraitExpliquerLeRefus } from './lib/refus';
import type { Browser, BrowserContext } from '@playwright/test';

const sabote = (s: string) => process.env.SSO_SABOTAGE === s;

/** E et F, le compte Rybbit à l'adresse de F relié à E. Idempotent : la liaison se rejoue sans effet. */
async function robert(browser: Browser) {
  const E = await compte(browser, 'E');
  const F = await compte(browser, 'F');
  if (!E.hubUserId) throw new NonAbouti('compte de test E sans hub_user_id');
  assurerRybbit(F);
  if (!sabote('adresse-liee') && !sabote('conflit')) rybbitCompte('lier', F.email, E.hubUserId);
  return { E, F };
}

/** E-mail de la session Rybbit (better-auth), lu dans le contexte qui vient d'arriver. */
async function emailRybbit(ctx: BrowserContext): Promise<string | null> {
  const r = await ctx.request.get(`${APP_URL.analytics}/api/auth/get-session`).catch(() => null);
  if (!r || r.status() >= 500) throw new NonAbouti(`session Rybbit illisible (${r ? 'HTTP ' + r.status() : 'injoignable'})`);
  const j = (await r.json().catch(() => null)) as { user?: { email?: string } } | null;
  return j?.user?.email?.toLowerCase() ?? null;
}

const atterri = (over: Partial<Atterrissage>): Atterrissage => ({
  app: 'analytics',
  url: `${HUB_URL}/auth/bounce/error?app=analytics&code=user_not_in_app`,
  hote: new URL(HUB_URL).host,
  chemin: '/auth/bounce/error',
  texte: 'Pas encore d\'accès à Veridian Analytics. Vous êtes connecté à Veridian avec x@veridian.site',
  formulaireMotDePasse: false,
  lienUnique: null,
  navigations: [],
  ...over,
});

cas(null, 'contrôle : « refus expliqué » tombe sur le retour muet au tableau de bord', async () => {
  const muet = atterri({ url: `${HUB_URL}/dashboard?app=analytics&hint=signup`, chemin: '/dashboard', texte: 'Vos outils' });
  expect(() => devraitExpliquerLeRefus(muet, 'user_not_in_app', 'x@veridian.site')).toThrow();
  expect(() => devraitExpliquerLeRefus(atterri({ texte: 'Impossible de revenir' }), 'user_not_in_app', 'x@veridian.site')).toThrow();
  expect(() => devraitExpliquerLeRefus(atterri({}), 'hub_user_conflict', 'x@veridian.site')).toThrow();
  expect(() => devraitExpliquerLeRefus(atterri({}), 'user_not_in_app', 'autre@veridian.site')).toThrow();
  expect(() => devraitExpliquerLeRefus(atterri({}), 'user_not_in_app', 'x@veridian.site')).not.toThrow();
});

cas('analytics', 'adresse au Hub différente de celle de l\'app, comptes reliés : arrivée dans son compte de l\'app', async ({ browser }) => {
  const { E, F } = await robert(browser);
  const ctx = await contexteDe(browser, E);
  try {
    const a = await ouvrirApp(ctx, 'analytics');
    devraitEtreArrive(a, 'analytics');
    expect(await emailRybbit(ctx), 'Rybbit : session du compte relié, à son adresse de l\'app').toBe(F.email.toLowerCase());
    return `Hub ${E.email} → Rybbit ${F.email} (relié par hub_user_id), arrivée sur ${a.chemin}`;
  } finally {
    await ctx.close();
  }
});

cas('analytics', 'une personne, deux comptes Hub : le second lit « rattaché à un autre compte », le premier garde l\'accès', async ({ browser }) => {
  const { E, F } = await robert(browser);
  const ctxF = await contexteDe(browser, F);
  try {
    const a = await ouvrirApp(ctxF, 'analytics');
    devraitExpliquerLeRefus(a, 'hub_user_conflict', F.email);
    expect(await emailRybbit(ctxF), 'Rybbit : aucune session ouverte pour le second compte').toBeNull();
  } finally {
    await ctxF.close();
  }
  // Le refus n'a rien déplacé : le compte relié s'ouvre toujours.
  const ctxE = await contexteDe(browser, E);
  try {
    devraitEtreArrive(await ouvrirApp(ctxE, 'analytics'), 'analytics');
    return `${F.email} refusé avec explication, ${E.email} entre toujours`;
  } finally {
    await ctxE.close();
  }
});

cas('analytics', 'adresse au Hub inconnue de l\'app : « pas encore d\'accès » avec son adresse, jamais un refus muet', async ({ browser }) => {
  const B = await compte(browser, 'B');
  if (sabote('inconnu')) assurerRybbit(B);
  const ctx = await contexteDe(browser, B);
  try {
    const a = await ouvrirApp(ctx, 'analytics');
    devraitExpliquerLeRefus(a, 'user_not_in_app', B.email);
    return `refus expliqué pour ${B.email} (${a.chemin})`;
  } finally {
    await ctx.close();
  }
});
