/**
 * SSO comme Infomaniak (VER-261) : un fournisseur qui n'affirme AUCUNE adresse (email_verified faux, adresse personnelle), RS256, portée openid. La personne
 * relie (fournisseur, sub) elle-même depuis ses réglages, connectée par ses propres moyens ; ensuite elle entre par lui. La session n'ouvre QUE cette
 * organisation : d'ailleurs aussi, elle est refusée, et celle qui vivait tombe ; elle ne donne pas d'accès à une IA. Organisation de test, jamais un client.
 * NON PROUVÉ : le vrai Infomaniak, au branchement.
 * Épreuves : `SSO_SABOTAGE=infomaniak-relier` ne relie pas ; `infomaniak-borne` n'ajoute pas la seconde organisation : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';

import { expect, type BrowserContext } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { ouvrirIdp, type IdentiteDite } from './lib/idp-jetable';
import { creerCompteProuve, type Compte } from './lib/parcours';

cas(null, 'SSO comme Infomaniak : chacun relie le sien, aucune adresse crue, la session n\'ouvre que son organisation', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const ouverts: BrowserContext[] = [];
  const P: Compte = await creerCompteProuve(browser, 'improp');
  const Q: Compte = await creerCompteProuve(browser, 'imautre');
  const M: Compte = await creerCompteProuve(browser, 'imm', undefined, true);
  const W: Compte = await creerCompteProuve(browser, 'imw', undefined, true);
  const org = async (c: Compte) => {
    const t = (await lookup(c.email)).json?.tenants?.[0] as { id: string; slug: string } | undefined;
    if (!t) throw new NonAbouti('compte de test sans organisation');
    await marquerTest(t.id);
    return t;
  };
  const [T, B] = [await org(P), await org(Q)];
  await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST SSO', modules: ['prospection'] });
  for (const c of [M, W]) await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: c.hubUserId });

  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  const idp = await ouvrirIdp(ip, 'RS256');
  try {
    const pose = await admin<{ error?: string }>('PUT', `organisations/${T.id}/idp`, { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret, domaines: [] });
    expect(pose.status, JSON.stringify(pose.json).slice(0, 200)).toBe(200);
    expect((await admin('PUT', `organisations/${T.id}/idp`, { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret, domaines: [], creation_auto: true })).status, 'création sans domaine : refusée').toBe(400);
    const INFO = (sub: string): IdentiteDite => ({ sub, email: 'perso.epreuve@gmail.com', email_verified: false });
    const session = async (c: BrowserContext) => ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string; federe?: boolean } } | null)?.user ?? null;
    /** Par la porte de l'organisation, navigateur neuf. */
    const entrer = async (qui: IdentiteDite) => {
      idp.dire(qui);
      const ctx = await browser.newContext();
      ouverts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/connexion/${T.slug}`, { waitUntil: 'networkidle' });
      const r = { ctx, chemin: new URL(page.url()).pathname, texte: (await page.locator('body').innerText()).slice(0, 1_500), email: (await session(ctx))?.email?.toLowerCase() ?? null };
      await page.close();
      return r;
    };
    /** Dans les réglages, par le bouton. */
    const relier = async (c: Compte, qui: IdentiteDite) => {
      idp.dire(qui);
      const ctx = await browser.newContext({ storageState: c.etat as never });
      ouverts.push(ctx);
      ctx.setDefaultTimeout(45_000);
      const page = await ctx.newPage();
      await page.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
      const bouton = page.getByRole('button', { name: /^Relier mon compte/ });
      await bouton.waitFor({ timeout: 20_000 });
      if (sabotage !== 'infomaniak-relier') {
        await bouton.click();
        await page.waitForURL((u) => u.origin === new URL(HUB_URL).origin && /federation/.test(`${u.pathname}${u.search}`)).catch(() => undefined);
      }
      const r = { chemin: `${new URL(page.url()).pathname}${new URL(page.url()).search}`, texte: (await page.locator('body').innerText()).slice(0, 500) };
      await page.close();
      return r;
    };

    const sonde = await entrer(INFO('900000'));
    if (/ne répond pas/.test(sonde.texte)) throw new NonAbouti(`le Hub n'atteint pas le fournisseur jetable (${ip})`);
    // Pas relié : refusé et dit ; même l'adresse EXACTE d'un membre, affirmée vérifiée, n'ouvre rien.
    expect([sonde.email, /pas encore relié/.test(sonde.texte), idp.portee()], sonde.texte).toEqual([null, true, 'openid']);
    expect((await entrer({ sub: '900001', email: M.email.toLowerCase(), email_verified: true })).email, 'adresse d\'un membre, non reliée').toBeNull();

    const lie = await relier(M, INFO('4815162342'));
    expect(lie.chemin, `M relie : ${lie.texte}`).toBe('/dashboard/settings?federation=reliee');
    const vole = await relier(W, INFO('4815162342'));
    expect([vole.chemin, /déjà relié/.test(vole.texte)], `un sub déjà pris : ${vole.texte}`).toEqual(['/auth/federation?code=autre_identite', true]);

    const un = await entrer(INFO('4815162342'));
    expect([un.email, un.chemin], un.texte).toEqual([M.email.toLowerCase(), '/dashboard']);
    // Son tableau de bord : les apps de l'organisation, aucun essai ; une app pas ouverte (CRM) est refusée et dite, aucun espace à elle n'est créé.
    expect([/TEST SSO/.test(un.texte), /Prospection/.test(un.texte), /essai/i.test(un.texte)], un.texte).toEqual([true, true, false]);
    const crm = await un.ctx.newPage();
    await crm.goto(`${HUB_URL}/login?next=${encodeURIComponent(`${APP_URL.twenty}/`)}`, { waitUntil: 'networkidle' }).catch(() => undefined);
    const refusCrm = `${new URL(crm.url()).pathname}${new URL(crm.url()).search}`;
    await crm.close();
    const depart = await un.ctx.request.post(`${HUB_URL}/api/tenants/start`, { data: { app: 'prospection' } });
    expect([refusCrm, depart.status(), ((await lookup(M.email)).json?.tenants ?? []).length], 'aucun espace à elle').toEqual([expect.stringContaining('/auth/bounce/error?app=crm&code=user_not_in_app'), 403, 0]);
    // Elle arrive dans l'app, dans l'organisation ; elle ne branche pas d'IA et ne touche pas à son compte.
    const page = await un.ctx.newPage();
    await page.goto(`${APP_URL.prospection}/`, { waitUntil: 'networkidle' }).catch(() => undefined);
    await expect.poll(async () => (await page.locator('body').innerText().catch(() => '')).includes('TEST SSO'), { timeout: 90_000, message: 'arrivée dans Prospection, dans l\'organisation' }).toBe(true);
    await page.close();
    const geste = await un.ctx.request.post(`${HUB_URL}/api/account/federation`, { headers: { origin: new URL(HUB_URL).origin }, data: { geste: 'delier', tenant_id: T.id } });
    const ia = await un.ctx.request.post(`${HUB_URL}/api/oauth/authorize`, { headers: { origin: new URL(HUB_URL).origin }, form: { decision: 'autoriser' } });
    expect([geste.status(), (await geste.json().catch(() => null))?.error, ia.status(), (await ia.json().catch(() => null))?.error], 'gestes de compte et IA').toEqual([403, 'session_federee', 403, 'session_federee']);

    // M rejoint une SECONDE organisation : sa session fédérée tombe, et n'en renaît pas ; la sienne, ordinaire, les voit toutes.
    if (sabotage !== 'infomaniak-borne') await adminOk('POST', `tenants/${B.id}/members`, { hub_user_id: M.hubUserId });
    expect(await session(un.ctx), 'la session fédérée qui vivait').toBeNull();
    const deux = await entrer(INFO('4815162342'));
    expect([deux.email, /autre organisation/.test(deux.texte)], deux.texte).toEqual([null, true]);
    const sienne = await browser.newContext({ storageState: M.etat as never });
    ouverts.push(sienne);
    expect((await session(sienne))?.email?.toLowerCase(), 'témoin : sa propre connexion vit toujours').toBe(M.email.toLowerCase());
    // Retirée de la seconde : elle entre à nouveau ; déliée : plus du tout.
    await admin('POST', `tenants/${B.id}/remove-member`, { hub_user_id: M.hubUserId });
    expect((await entrer(INFO('4815162342'))).email, 'revenue à une seule organisation').toBe(M.email.toLowerCase());
    expect((await sienne.request.post(`${HUB_URL}/api/account/federation`, { headers: { origin: new URL(HUB_URL).origin }, data: { geste: 'delier', tenant_id: T.id } })).status()).toBe(200);
    expect((await entrer(INFO('4815162342'))).email, 'déliée').toBeNull();
    return 'adresse jamais crue, même exacte ; reliée par sa personne ; un sub = une personne ; arrivée dans Prospection ; ni IA ni compte ; seconde organisation : la session tombe et ne renaît pas, la sienne vit ; déliée : fermée';
  } finally {
    await admin('DELETE', `organisations/${T.id}/idp`).catch(() => undefined);
    await idp.fermer();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 900_000 });
