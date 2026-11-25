/**
 * Fédération OIDC d'une organisation (VER-227 S2) : un vrai fournisseur, jetable, dans ce processus (adresse tailnet, sans port public). Une personne
 * attendue entre par lui et arrive dans l'app ; hors domaine, pas attendue, jeton faux, compte existant repris par son adresse : refusés. M2 : un
 * compte ouvert par un autre, sans preuve, revient au vrai titulaire et l'ancien accès meurt. Retirée : ne revient pas. Fermé : plus de porte.
 * Épreuve : `SSO_SABOTAGE=federation` n'attend pas la personne : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';

import { expect } from '@playwright/test';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { ouvrirIdp, type IdentiteDite, type Mensonge } from './lib/idp-jetable';
import { adresseDe, attendreSessionHub, connexionHub, creerCompteNonProuve, creerCompteProuve, noter, type Compte } from './lib/parcours';

const DOMAINE = 'veridian.site';

cas(null, 'fédération : le fournisseur d\'une organisation fait entrer les siens, et personne d\'autre', async ({ browser }) => {
  const staging = /staging/.test(HUB_URL);
  const P: Compte = await creerCompteProuve(browser, 'fedprop');
  let T = (await lookup(P.email)).json?.tenants?.[0];
  if (!T && staging) {
    await adminOk('POST', 'tenants/app-access', { user_email: P.email, app: 'twenty', enabled: true });
    T = (await lookup(P.email)).json?.tenants?.[0];
  }
  if (!T) throw new NonAbouti('compte de test sans tenant');
  await marquerTest(T.id);
  if (!staging) await adminOk('PUT', `organisations/${T.id}`, { type: 'organisation', nom_affiche: 'TEST fédération', modules: ['prospection'] });

  const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  const idp = await ouvrirIdp(ip);
  try {
    const pose = await admin<{ connexion: string; error?: string }>('PUT', `organisations/${T.id}/idp`, { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret, domaines: [DOMAINE] });
    expect(pose.status, JSON.stringify(pose.json).slice(0, 200)).toBe(200);
    const porte = `${HUB_URL}/connexion/${T.slug}`;

    /** Une personne arrive par la porte de l'organisation, dans un vrai navigateur. `etat` : déjà connectée au Hub. */
    const arriver = async (qui: IdentiteDite, o: { etat?: unknown; mensonge?: Mensonge; app?: boolean } = {}) => {
      idp.dire(qui);
      idp.mentir(o.mensonge ?? null);
      const ctx = await browser.newContext(o.etat ? { storageState: o.etat as never } : {});
      ctx.setDefaultTimeout(45_000);
      try {
        const page = await ctx.newPage();
        await page.goto(porte, { waitUntil: 'networkidle' });
        const r = { chemin: new URL(page.url()).pathname, texte: (await page.locator('body').innerText()).slice(0, 600), email: null as string | null, app: '' };
        const s = (await (await ctx.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string } } | null;
        r.email = s?.user?.email?.toLowerCase() ?? null;
        if (o.app && r.email) {
          await page.goto(`${APP_URL.prospection}/`, { waitUntil: 'networkidle' });
          await page.waitForFunction(() => !/Ouverture d.Atlas/.test(document.body.innerText) && document.body.innerText.trim().length > 40).catch(() => undefined);
          r.app = await page.locator('body').innerText();
        }
        return { ...r, etat: await ctx.storageState() };
      } finally {
        await ctx.close();
      }
    };
    const M = adresseDe('fedm').toLowerCase();
    noter(M);

    // Le fournisseur répond-il au Hub ? Sinon rien n'est mesuré.
    const sonde = await arriver({ sub: 'sonde', email: `sonde@ailleurs.test` });
    if (/ne répond pas/.test(sonde.texte)) throw new NonAbouti(`le Hub n'atteint pas le fournisseur jetable (${ip}) : ${sonde.texte.slice(0, 120)}`);
    expect([sonde.chemin, sonde.email, /domaines de cette organisation/.test(sonde.texte)], `hors domaine : ${sonde.texte}`).toEqual(['/auth/federation', null, true]);

    // Pas attendue, puis attendue : elle entre, et arrive dans l'app.
    const avant = await arriver({ sub: 'm-1', email: M });
    expect([avant.email, /ne vous attend pas/.test(avant.texte)], avant.texte).toEqual([null, true]);
    if (process.env.SSO_SABOTAGE !== 'federation') await adminOk('POST', `organisations/${T.id}/membres`, { membres: [{ email: M }] });
    for (const m of ['signature', 'nonce', 'audience', 'emetteur', 'expire'] as const) {
      const faux = await arriver({ sub: 'm-1', email: M }, { mensonge: m });
      expect([faux.email, /n'a pas pu être vérifiée/.test(faux.texte)], `jeton faux (${m}) : ${faux.texte}`).toEqual([null, true]);
    }
    const entree = await arriver({ sub: 'm-1', email: M, name: 'TEST M' }, { app: !staging });
    expect([entree.chemin, entree.email], entree.texte).toEqual(['/dashboard', M]);
    if (!staging) expect(entree.app, 'arrivée dans l\'organisation').toContain('TEST fédération');
    const hubM = (await lookup(M)).json?.user?.supabase_user_id as string;
    expect((await arriver({ sub: 'm-1', email: 'renommee@veridian.site' })).email, 'même identité, adresse changée : la même personne').toBe(M);
    expect((await arriver({ sub: 'm-2', email: M })).email, 'autre identité, même adresse (recyclée)').toBeNull();

    // Compte existant et prouvé : jamais repris par son adresse ; sa personne, connectée, le relie.
    const E: Compte = await creerCompteProuve(browser, 'fede', undefined, true);
    const repris = await arriver({ sub: 'e-1', email: E.email.toLowerCase() });
    expect([repris.email, /existe déjà/.test(repris.texte)], repris.texte).toEqual([null, true]);
    const M2 = await arriver({ sub: 'e-1', email: E.email.toLowerCase() }, { etat: entree.etat });
    expect(M2.email, 'connectée en M, elle ne devient pas E').toBe(M);
    expect((await arriver({ sub: 'e-1', email: E.email.toLowerCase() }, { etat: E.etat })).chemin, 'E relie son compte').toBe('/dashboard');
    expect((await arriver({ sub: 'e-1', email: E.email.toLowerCase() })).email, 'relié : entre sans autre session').toBe(E.email.toLowerCase());

    // M2 : N a été ouvert par quelqu'un qui n'a pas prouvé l'adresse. Le vrai titulaire arrive par son organisation ; l'ancien accès meurt.
    const N: Compte = await creerCompteNonProuve(browser, 'fedn');
    if (!N.etat) throw new NonAbouti('le compte non prouvé n\'a pas ouvert de session : M2 ne peut pas être joué');
    const vivante = async (etat: unknown) => {
      const c = await browser.newContext({ storageState: etat as never });
      try {
        return ((await (await c.request.get(`${HUB_URL}/api/auth/session`)).json().catch(() => null)) as { user?: { email?: string } } | null)?.user?.email?.toLowerCase() ?? null;
      } finally {
        await c.close();
      }
    };
    expect(await vivante(N.etat), 'contrôle positif : la session de l\'usurpateur vivait').toBe(N.email.toLowerCase());
    await new Promise((ok) => setTimeout(ok, 1_500)); // la coupure se lit à la seconde
    expect((await arriver({ sub: 'n-1', email: N.email.toLowerCase() })).email, 'le vrai titulaire entre').toBe(N.email.toLowerCase());
    expect(await vivante(N.etat), 'session d\'avant la preuve').toBeNull();
    const ancien = await browser.newContext();
    try {
      await connexionHub(await ancien.newPage(), N.email, N.motDePasse);
      expect(await attendreSessionHub(ancien, N.email, 12_000), 'mot de passe d\'avant la preuve').toBe(false);
    } finally {
      await ancien.close();
    }

    // Retirée : son fournisseur ne la fait pas revenir. Porte fermée : la connexion habituelle.
    await admin('POST', `tenants/${T.id}/remove-member`, { hub_user_id: hubM });
    const retiree = await arriver({ sub: 'm-1', email: M });
    expect([retiree.email, /retiré de cette organisation/.test(retiree.texte)], retiree.texte).toEqual([null, true]);
    await adminOk('DELETE', `organisations/${T.id}/idp`);
    expect((await arriver({ sub: 'e-1', email: E.email.toLowerCase() })).chemin, 'porte fermée').toBe('/login');
    return `attendue entrée${staging ? '' : ' et arrivée dans Prospection'} ; hors domaine, pas attendue, 5 jetons faux, identité recyclée, compte existant : refusés ; relié par sa personne ; M2 : l'usurpateur perd session et mot de passe ; retirée : ne revient pas ; fermée`;
  } finally {
    await admin('DELETE', `organisations/${T.id}/idp`).catch(() => undefined);
    await idp.fermer();
  }
}, { timeout: 900_000 });
