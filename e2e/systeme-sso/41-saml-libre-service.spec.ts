/**
 * SAML, posé par le propriétaire lui-même, à l'écran (VER-227) : il colle l'émetteur, l'adresse et le certificat, essaie avec son compte, active ; rien ne
 * s'ouvre avant l'essai. Un membre relie le sien, entre par la porte de l'organisation, sa session est bornée. Tout ce qu'un fournisseur fausse est refusé.
 * Fournisseur SAML jetable, organisation de test. NON PROUVÉ : un vrai fournisseur SAML du marché. Captures : .run/captures/.
 * Épreuves : `SSO_SABOTAGE=saml-certificat` pose le certificat d'un autre ; `saml-essai` n'essaie pas : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type BrowserContext, type Page } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { creerCompteProuve, type Compte } from './lib/parcours';
import { ouvrirSaml, type MensongeSaml } from './lib/saml-jetable';
import { RUN_DIR } from './lib/versions';

const capture = async (page: Page, nom: string) => {
  mkdirSync(join(RUN_DIR, 'captures'), { recursive: true });
  await page.screenshot({ path: join(RUN_DIR, 'captures', `${nom}.png`), fullPage: true });
};

cas(null, 'SAML en libre-service : le propriétaire pose, essaie, active ; un membre relie et entre, borné ; tout faux est refusé', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('épreuve de prod (organisations réglées)');
  const sabotage = process.env.SSO_SABOTAGE ?? '';
  const P: Compte = await creerCompteProuve(browser, 'samlprop');
  const M: Compte = await creerCompteProuve(browser, 'samlmem', undefined, true);
  const T = (await lookup(P.email)).json?.tenants?.[0] as { id: string; slug: string } | undefined;
  if (!T) throw new NonAbouti('compte de test sans organisation');
  await marquerTest(T.id);
  await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST SAML', modules: ['prospection'] });
  await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  const idp = await ouvrirSaml(ip);
  const ouverts: BrowserContext[] = [];
  const ctxDe = async (c?: Compte) => { const x = await browser.newContext({ ...(c ? { storageState: c.etat as never } : {}), viewport: { width: 1280, height: 900 } }); x.setDefaultTimeout(45_000); ouverts.push(x); return x; };
  const session = async (c: BrowserContext) => ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string; federe?: boolean } } | null)?.user ?? null;
  try {
    const prop = await ctxDe(P);
    const page = await prop.newPage();
    const ecran = async () => { await page.goto(`${HUB_URL}/dashboard/organisation`, { waitUntil: 'networkidle' }); await page.getByText('Se connecter avec le compte de votre organisation').click(); };
    const avis = () => page.getByRole('status').first().innerText();
    await ecran();
    await page.getByText('SAML 2.0', { exact: true }).click();
    await capture(page, 'organisation-saml');
    await page.getByLabel("Identifiant d'entité du fournisseur").fill(idp.issuer);
    await page.getByLabel('Adresse de connexion (SSO)').fill(idp.sso);
    await page.getByLabel('Certificat de signature (X.509)').fill(sabotage === 'saml-certificat' ? idp.autreCertificat : idp.certificat);
    await page.locator('form', { has: page.getByLabel('Certificat de signature (X.509)') }).getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForURL(/avis=/);
    expect(await avis()).toContain('Fournisseur enregistré');

    /** Par la porte de l'organisation, navigateur neuf. */
    const entrer = async (sub: string, m: MensongeSaml = null) => {
      idp.dire(sub);
      idp.mentir(m);
      const ctx = await ctxDe();
      const p = await ctx.newPage();
      await p.goto(`${HUB_URL}/connexion/${T.slug}`, { waitUntil: 'networkidle' });
      await p.waitForURL((u) => u.origin === new URL(HUB_URL).origin).catch(() => undefined);
      await p.waitForLoadState('networkidle');
      const r = { ctx, chemin: new URL(p.url()).pathname, texte: (await p.locator('body').innerText()).slice(0, 1_500), email: (await session(ctx))?.email?.toLowerCase() ?? null };
      await p.close();
      idp.mentir(null);
      return r;
    };
    // Posé, jamais essayé : fermé, et aucun bouton pour l'ouvrir.
    expect([(await entrer('s-1')).chemin, idp.demandes()], 'avant l\'essai').toEqual(['/login', 0]);
    await ecran();
    expect(await page.getByRole('button', { name: 'Activer' }).count()).toBe(0);
    expect((await (async () => (await prop.request.post(`${HUB_URL}/api/organisations/fournisseur`, { headers: { origin: new URL(HUB_URL).origin }, form: { tenant: T.id, geste: 'activer' }, maxRedirects: 0 })).headers().location)()), 'forcé sans l\'écran').toContain('essai_manquant');

    if (sabotage !== 'saml-essai') {
      idp.dire('sub-proprietaire');
      await page.getByRole('button', { name: 'Essayer' }).click();
      await page.waitForURL((u) => u.origin === new URL(HUB_URL).origin && /avis=|federation/.test(`${u.pathname}${u.search}`)).catch(() => undefined);
      if (/ne répond pas/.test(await page.locator('body').innerText())) throw new NonAbouti(`le navigateur n'atteint pas le fournisseur jetable (${ip})`);
      expect(new URL(page.url()).search, await page.locator('body').innerText()).toContain('essai_reussi');
      await ecran();
    }
    await page.getByRole('button', { name: 'Activer' }).click({ timeout: 10_000 });
    await page.waitForURL(/fournisseur_actif/);
    await page.getByText('Se connecter avec le compte de votre organisation').click();
    await capture(page, 'organisation-saml-actif');
    const demandesAvant = idp.demandes();

    // Actif : personne n'est relié, l'essai n'a relié personne.
    const sonde = await entrer('sub-proprietaire');
    expect([sonde.email, /pas encore relié/.test(sonde.texte)], sonde.texte).toEqual([null, true]);
    expect(idp.demandes()).toBeGreaterThan(demandesAvant);
    // Le membre relie le sien, par le bouton.
    const mem = await ctxDe(M);
    const pm = await mem.newPage();
    idp.dire('sub-membre');
    await pm.goto(`${HUB_URL}/dashboard/settings`, { waitUntil: 'networkidle' });
    await pm.getByRole('button', { name: /^Relier mon compte/ }).click({ timeout: 20_000 });
    await pm.waitForURL((u) => u.origin === new URL(HUB_URL).origin && /federation/.test(`${u.pathname}${u.search}`)).catch(() => undefined);
    expect(new URL(pm.url()).search, (await pm.locator('body').innerText()).slice(0, 300)).toBe('?federation=reliee');
    const un = await entrer('sub-membre');
    expect([un.email, un.chemin, (await session(un.ctx))?.federe], un.texte).toEqual([M.email.toLowerCase(), '/dashboard', true]);
    expect((await un.ctx.request.post(`${HUB_URL}/api/organisations/fournisseur`, { headers: { origin: new URL(HUB_URL).origin }, form: { tenant: T.id, geste: 'couper' }, maxRedirects: 0 })).status(), 'une session fédérée ne règle rien').toBe(403);

    const faux: Exclude<MensongeSaml, null>[] = ['signature', 'sans_signature', 'audience', 'emetteur', 'expire', 'autre_demande', 'sans_demande', 'sha1', 'adresse', 'ephemere', 'deux_assertions', 'commentaire', 'apres_signature'];
    const passes: string[] = [];
    for (const f of faux) if ((await entrer('sub-membre', f)).email) passes.push(f);
    expect(passes, 'réponses fausses qui ont ouvert').toEqual([]);
    // Une réponse rejouée dans un autre navigateur, sans sa demande.
    const ailleurs = await ctxDe();
    const rejeu = await ailleurs.request.post(`${HUB_URL}/api/auth/federation/saml`, { form: { SAMLResponse: idp.repondre({ id: '_x', acs: `${HUB_URL}/api/auth/federation/saml`, sp: `${HUB_URL}/saml/${T.id}` }) }, maxRedirects: 0 });
    expect([rejeu.headers().location?.includes('demande_expiree'), await session(ailleurs)], 'sans demande dans ce navigateur').toEqual([true, null]);

    // Le propriétaire coupe : la porte se ferme, la connexion habituelle du membre vit.
    await page.getByRole('button', { name: 'Couper' }).click();
    await page.waitForURL(/fournisseur_coupe/);
    expect((await entrer('sub-membre')).chemin).toBe('/login');
    expect((await session(mem))?.email?.toLowerCase()).toBe(M.email.toLowerCase());
    return `${faux.length} réponses fausses refusées ; fermé avant l'essai, même forcé ; essai, activation et coupure à l'écran ; membre relié, entré, borné`;
  } finally {
    await admin('DELETE', `organisations/${T.id}/idp`).catch(() => undefined);
    await idp.fermer();
    for (const c of ouverts) await c.close().catch(() => undefined);
  }
}, { timeout: 900_000 });
