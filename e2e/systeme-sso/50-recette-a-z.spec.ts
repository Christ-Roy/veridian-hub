/**
 * Recette de A à Z en PROD (parente, 26/11) : UNE organisation jetable, libellée e2e, adresse sur notre domaine, traverse tout le parcours d'un
 * client, de l'inscription par l'écran à la suppression. Chaque étape rend vrai, faux ou non abouti avec sa capture réelle, et la recette continue
 * après un faux. Tableau : `.run/recette/tableau.md`. Prod seulement, jamais lancée par la batterie complète (filtre `50-`).
 * Ce qu'elle ne fait JAMAIS : lire une boîte (il n'y en a pas, `lib/boite.ts`), envoyer un mail réel, allumer une séquence, toucher un client.
 */
import { randomBytes } from 'node:crypto';

import { APP_URL, HUB_URL, type AppKey } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerAnalyticsAuHub, activerTwentyAuHub, admin, invite, lookup, marquerTest } from './lib/hub-admin';
import { mesurerRestes, nettoyerCompte } from './lib/nettoyage';
import { adresseDe, attendreSessionHub, connexionHub, noter, noterEspaceTwenty, noterRybbit, noterWorkspace, voirApp, type Compte } from './lib/parcours';
import { creerRecette, type Recette } from './lib/recette';
import { delegationCrmVersMail, envoyerAuCrm, monIA, reponseMailVersCrm } from './lib/recette-integrations';
import { fermerCoupures, inviterMembre, retraitMembre, ssoLibre, ssoObligatoire, suspensionOrganisation } from './lib/recette-coupures';
import { assurerRybbit } from './lib/monde';

const ACADEMY_URL = process.env.ACADEMY_URL || 'https://academy.app.veridian.site';
const CMS_URL = process.env.CMS_URL || 'https://cms.app.veridian.site';
const hote = (u: string) => new URL(u).host;

/** Le geste du client : depuis sa session Hub, il ouvre l'app ; on regarde où il arrive, on capture, puis l'app relit sa session. */
async function entrer(r: Recette, nom: string, url: string, app?: AppKey): Promise<string> {
  const ctx = await r.contexte(r.P);
  try {
    const page = await ctx.newPage();
    const cible = hote(url);
    await page.goto(`${HUB_URL}/login?next=${encodeURIComponent(url.replace(/\/?$/, '/'))}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForURL((u) => u.host === cible || u.host.endsWith(`.${cible}`) || /\/auth\/bounce\/error/.test(u.pathname), { timeout: 60_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(app === 'twenty' ? 15_000 : 4_000);
    await r.capture(page, nom);
    const u = new URL(page.url());
    if (/\/auth\/bounce\/error/.test(u.pathname)) throw new Error(`rebond refusé vers ${nom} : ${u.searchParams.get('code') ?? 'sans code'}`);
    if (u.host !== cible && !u.host.endsWith(`.${cible}`)) throw new Error(`${nom} : resté sur ${u.host}${u.pathname}, l'app n'est jamais atteinte`);
    const formulaire = (await page.locator('input[type=password]').count().catch(() => 0)) > 0;
    if (formulaire || /login|signin|sign-in/.test(u.pathname)) throw new Error(`${nom} : arrivée sur une page de connexion (${u.pathname}), pas dans l'app`);
    if (!app) return `arrivé sur ${u.host}${u.pathname}, aucune saisie`;
    const vue = await voirApp(ctx, app);
    if (!vue.connecte) throw new Error(`${nom} : l'app ne relit aucune session (${vue.hote}${vue.chemin})`);
    if (app === 'twenty') r.notes.hoteCrm = vue.hote;
    return `arrivé sur ${u.host}${u.pathname}, session relue par l'app, aucune saisie`;
  } finally {
    await ctx.close();
  }
}

cas(null, 'recette de A à Z : une organisation jetable, de l\'inscription à la suppression, chaque étape mesurée et capturée', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('recette de prod');
  const email = adresseDe('recette');
  const motDePasse = `Rc-${randomBytes(12).toString('base64url')}9!`;
  noter(email); // au registre AVANT de naître : un arrêt brutal ne laisse rien (nettoyage, 99-)
  const P: Compte = { etiquette: 'recette', email, nom: email, motDePasse, hubUserId: null, tenantId: null, etat: null };
  const { r, etape, ecrire, tableau } = creerRecette(browser, P, '(pas encore née)');

  try {
    await etape('Inscription par l\'écran du Hub', async () => {
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        await page.goto(`${HUB_URL}/signup`, { waitUntil: 'networkidle' });
        await page.locator('#email').fill(email);
        await page.locator('#password').fill(motDePasse);
        await page.locator('#confirmPassword').fill(motDePasse);
        await r.capture(page, 'formulaire');
        await page.locator('button[type=submit]').click();
        await page.waitForURL((u) => !/\/signup/.test(u.pathname), { timeout: 30_000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
        await r.capture(page, 'apres-inscription');
        if (!(await attendreSessionHub(ctx, email, 10_000))) {
          await connexionHub(page, email, motDePasse);
          if (!(await attendreSessionHub(ctx, email, 30_000))) throw new Error('compte inscrit, mais aucune session Hub, même par le mot de passe');
        }
        const u = (await lookup(email)).json;
        if (!u?.user) throw new Error('inscription acceptée à l\'écran, mais le Hub ne connaît pas la personne');
        if (u.user.email_verified) throw new Error('adresse déjà prouvée sans aucune preuve');
        P.hubUserId = u.user.supabase_user_id ?? null;
        P.etat = await ctx.storageState();
        await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
        await r.capture(page, 'tableau-de-bord-non-prouve');
        return `personne née au Hub, session ouverte, adresse non prouvée ; ${u.tenants?.length ?? 0} organisation(s)`;
      } finally {
        await ctx.close();
      }
    });

    await etape('Sans preuve d\'adresse, aucune app ne s\'ouvre', async () => {
      const ctx = await r.contexte(P);
      try {
        const page = await ctx.newPage();
        await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
        const bandeau = await page.getByText(/Confirmez votre adresse/i).count();
        await r.capture(page, 'bandeau-preuve');
        const vue = await voirApp(ctx, 'prospection');
        if (vue.connecte) throw new Error('Prospection ouverte sans adresse prouvée');
        return `bandeau de preuve ${bandeau ? 'affiché' : 'ABSENT'}, Prospection fermée (${vue.hote}${vue.chemin})`;
      } finally {
        await ctx.close();
      }
    });

    await etape('Preuve d\'adresse par le mail reçu', async () => {
      throw new NonAbouti('aucune boîte d\'épreuve lisible (lib/boite.ts) : le lien envoyé à l\'inscription n\'est pas lu ; Robert doit en désigner une');
    });

    await etape('Preuve d\'adresse par le lien d\'invitation (chemin d\'un client invité)', async () => {
      const inv = await invite(email, ['hub', 'prospection', 'notifuse', 'analytics'], 'RECETTE A A Z');
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        await page.goto(inv.invite_url, { waitUntil: 'networkidle' });
        await r.capture(page, 'invitation');
        await page.getByRole('button', { name: /Activer mon compte/i }).click();
        await page.getByLabel('Mot de passe', { exact: true }).fill(motDePasse);
        await page.getByLabel('Confirmation').fill(motDePasse);
        await page.getByRole('button', { name: /Créer mon accès/i }).click();
        if (!(await attendreSessionHub(ctx, email, 45_000))) {
          await connexionHub(page, email, motDePasse);
          if (!(await attendreSessionHub(ctx, email, 30_000))) throw new Error('aucune session Hub après l\'activation');
        }
        let u: any = null;
        for (let i = 0; i < 40 && !(u?.user?.email_verified && u?.tenants?.[0]?.notifuseWorkspaceSlug && u?.tenants?.[0]?.prospectionProvisionedAt); i++) {
          u = (await lookup(email)).json;
          await new Promise((ok) => setTimeout(ok, 1500));
        }
        if (!u?.user?.email_verified) throw new Error('adresse toujours non prouvée après le lien');
        const T = u.tenants?.[0];
        if (!T) throw new Error('adresse prouvée, mais aucune organisation');
        P.tenantId = T.id;
        r.tenantId = T.id;
        await marquerTest(T.id);
        if (T.notifuseWorkspaceSlug) { noterWorkspace(email, T.notifuseWorkspaceSlug); r.notes.slugMail = T.notifuseWorkspaceSlug; }
        P.etat = await ctx.storageState();
        await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
        await r.capture(page, 'tableau-de-bord-prouve');
        return `adresse prouvée, organisation ${T.id} (marquée de test), Mail ${T.notifuseWorkspaceSlug ? 'créé' : 'ABSENT'}, Prospection ${T.prospectionProvisionedAt ? 'créée' : 'ABSENTE'}`;
      } finally {
        await ctx.close();
      }
    });

    await etape('Ouverture d\'un coup de toutes les apps (VER-263)', async () => {
      const t = P.tenantId;
      if (!t) throw new NonAbouti('aucune organisation : la preuve d\'adresse n\'a pas abouti');
      const o = await admin<{ apps: { app: string; etat: string; detail?: string }[]; verdict: string }>('POST', `tenants/${t}/ouvrir`, { apps: ['notifuse', 'prospection', 'crm', 'academy', 'analytics'] });
      noterEspaceTwenty(email, t);
      // Relecture idempotente de l'espace CRM (aucune création si l'ouverture l'a fait) : les étapes d'intégration en ont besoin.
      r.notes.espaceCrm = await activerTwentyAuHub(email).catch(() => '');
      const ctx = await r.contexte(P);
      try {
        const page = await ctx.newPage();
        await page.goto(`${HUB_URL}/dashboard`, { waitUntil: 'networkidle' });
        await r.capture(page, 'tuiles');
      } finally {
        await ctx.close();
      }
      const lignes = (o.json?.apps ?? []).map((a) => `${a.app} ${a.etat}${a.detail ? ` (${a.detail})` : ''}`).join(' ; ');
      if (o.status >= 400) throw new Error(`ouverture refusée : HTTP ${o.status} ${JSON.stringify(o.json).slice(0, 160)}`);
      if (o.json?.verdict !== 'complet') throw new Error(`verdict ${o.json?.verdict} : ${lignes}`);
      return `complet : ${lignes}`;
    });

    await etape('Entrée SSO dans Mail', (x) => entrer(x, 'mail', `${APP_URL.notifuse}/console`, 'notifuse'));
    await etape('Entrée SSO dans le CRM', (x) => entrer(x, 'crm', APP_URL.twenty, 'twenty'));
    await etape('Entrée SSO dans Prospection', (x) => entrer(x, 'prospection', APP_URL.prospection, 'prospection'));
    await etape('Entrée SSO dans Academy', (x) => entrer(x, 'academy', ACADEMY_URL));
    const analytics = await etape('Entrée SSO dans Analytics, sans aucun geste d\'opérateur', async (x) => {
      await activerAnalyticsAuHub(email);
      return entrer(x, 'analytics', APP_URL.analytics, 'analytics');
    });
    if (analytics !== 'VRAI') {
      await etape('Entrée SSO dans Analytics, après création du compte par l\'opérateur', async (x) => {
        noterRybbit(email);
        assurerRybbit(P);
        return entrer(x, 'analytics-operateur', APP_URL.analytics, 'analytics');
      });
    }
    await etape('Entrée SSO dans le CMS', async (x) => {
      const a = await admin('POST', 'tenants/app-access', { user_email: email, app: 'cms', enabled: true });
      if (a.status !== 200) throw new NonAbouti(`le Hub n'ouvre pas le CMS à l'organisation : HTTP ${a.status} ${JSON.stringify(a.json).slice(0, 140)}`);
      return entrer(x, 'cms', CMS_URL);
    });

    await etape('Envoyer au CRM depuis Prospection (VER-246)', envoyerAuCrm);
    await etape('Réponse reçue dans Mail vers la fiche CRM (VER-247)', reponseMailVersCrm);
    await etape('Délégation : le CRM agit dans Mail (VER-245)', delegationCrmVersMail);
    await etape('Mon IA (VER-203)', monIA);
    await etape('Invitation d\'un membre, qui entre partout', inviterMembre);
    await etape('SSO d\'organisation en libre service', ssoLibre);
    await etape('SSO d\'organisation obligatoire, puis rendu libre', ssoObligatoire);
    await etape('Retrait du membre : perte d\'accès partout (VER-245, VER-260, VER-231)', retraitMembre);
    await etape('Suspension de l\'organisation : perte d\'accès partout, puis retour', suspensionOrganisation);

    await etape('Suppression de l\'organisation, mesurée dans chaque app', async () => {
      const ws = r.notes.slugMail;
      for (const c of [r.M, P].filter(Boolean) as Compte[]) await nettoyerCompte(c.email);
      if ((await lookup(email)).status !== 404) throw new Error('la personne est encore au Hub');
      const restes = (await mesurerRestes()).filter((x) => x.includes(email.split('@')[0]) || (ws && x.includes(ws)));
      if (restes.length) throw new Error(`restes après suppression : ${restes.join(', ')}`);
      return 'personne et organisation retirées du Hub ; reconcile et Mail : 0 reste de la recette';
    });
  } finally {
    // Fournisseur jetable fermé, connexion remise en libre, suspension levée : même après un faux, avant toute suppression.
    await fermerCoupures(r).catch((e) => console.error(`[recette] fermeture des coupures : ${String(e).slice(0, 200)}`));
    // Un arrêt en route ne laisse rien : la suppression se rejoue si l'étape ne l'a pas faite.
    if ((await lookup(email).catch(() => ({ status: 0 }))).status === 200) await nettoyerCompte(email).catch((e) => console.error(`[recette] nettoyage : ${String(e).slice(0, 200)}`));
    if (r.M && (await lookup(r.M.email).catch(() => ({ status: 0 }))).status === 200) await nettoyerCompte(r.M.email).catch(() => undefined);
    console.log(ecrire());
  }
  const l = tableau();
  const faux = l.filter((x) => x.etat === 'FAUX');
  const na = l.filter((x) => x.etat === 'NON_ABOUTI');
  const resume = `${l.length - faux.length - na.length} vrai, ${faux.length} faux, ${na.length} non abouti ; tableau .run/recette/tableau.md`;
  if (faux.length) throw new Error(`${resume} ; faux : ${faux.map((x) => x.n).join(', ')}`);
  return resume;
}, { timeout: 3 * 3_600_000 });

