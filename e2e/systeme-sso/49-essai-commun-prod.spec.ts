/**
 * Essai commun en PROD, organisation marquée de test (VER-245, portées) : la même chose que le cas 48, par le vrai chemin du Hub. Une personne née
 * au Hub, propriétaire ; Mail et Prospection ouverts par `ouvrir` (lien de l'espace Mail compris), CRM et Academy par l'accès de l'opérateur. Le CRM
 * installe Liaisons et CLIQUE ; le Hub éteint ou rallume `crm>notifuse#sequences` par l'écran du propriétaire, au signal. Aucun client réel touché.
 * Fiche : ~/credentials/essai-crm-prod.json (600), effacée à la fin. Fin : `.run/essai-crm-fin` (ou `SSO_ESSAI_MINUTES`, 120). Prod seulement.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup, marquerTest } from './lib/hub-admin';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';
import { RUN_DIR } from './lib/versions';

const SEQUENCES = 'crm>notifuse#sequences';


/** Durée de l'essai ; le délai du test en découle (+30 min de ménage). 26/11 : délai figé à 3 h pour un essai annoncé 12 h, l'organisation de
 * Mail A a été retirée en plein travail par le nettoyage de fin de batterie. */
const DUREE_ESSAI_MS = Number(process.env.SSO_ESSAI_MINUTES ?? 120) * 60_000;

cas(null, 'essai commun en prod : une organisation de test, le CRM clique ses liaisons vers Mail, Prospection et Academy', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('essai commun de prod (le cas 48 couvre staging)');
  const fiche = join(homedir(), 'credentials', 'essai-crm-prod.json');
  const fin = join(RUN_DIR, 'essai-crm-fin');
  rmSync(fin, { force: true });
  try {
    const P: Compte = await creerCompteProuve(browser, 'essaicrmprod');
    const T = (await lookup(P.email)).json?.tenants?.[0];
    if (!T) throw new NonAbouti('compte d\'essai sans tenant');
    await marquerTest(T.id);
    const ouvert = await adminOk<{ apps: { app: string; etat: string; detail?: string }[]; verdict: string }>('POST', `tenants/${T.id}/ouvrir`, { apps: ['notifuse', 'prospection'] });
    if (ouvert.apps.some((a) => a.etat !== 'ouverte')) throw new NonAbouti(`ouverture : ${JSON.stringify(ouvert.apps)}`);
    const espaceCrm = await activerTwentyAuHub(P.email);
    noterEspaceTwenty(P.email, T.id);
    const aca = await admin<{ academy_workspace_id?: string; error?: string }>('POST', 'tenants/app-access', { user_email: P.email, app: 'academy', enabled: true });
    const lu = (await lookup(P.email)).json?.tenants?.[0] ?? {};
    writeFileSync(fiche, JSON.stringify({ hub: HUB_URL, email: P.email, mot_de_passe: P.motDePasse, hub_user_id: P.hubUserId, hub_tenant_id: T.id, espace_crm: espaceCrm, espace_mail: lu.notifuseWorkspaceSlug ?? lu.notifuse_workspace_slug ?? null, academy: aca.status === 200 ? (aca.json?.academy_workspace_id ?? 'ouverte') : `refus ${aca.status}`, cree_le: new Date().toISOString() }, null, 1), { mode: 0o600 });
    console.log(`[essai-crm-prod] prêt : tenant ${T.id}, espace CRM ${espaceCrm}, Academy ${aca.status} ; fiche ${fiche}`);
    const geste = async (quoi: 'Allumer' | 'Couper') => {
      const ctx = await browser.newContext({ storageState: P.etat as never });
      try {
        const page = await ctx.newPage();
        await page.goto(`${HUB_URL}/dashboard/liaisons`, { waitUntil: 'networkidle' });
        await page.locator('form', { has: page.locator(`input[name="paire"][value="${SEQUENCES}"]`) }).getByRole('button', { name: quoi }).click();
        if (quoi === 'Allumer') { await page.waitForURL(/\/liaisons\/confirmer\//); await page.getByRole('button', { name: 'Allumer' }).click(); }
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: join(RUN_DIR, 'captures', `essai-prod-${quoi.toLowerCase()}.png`), fullPage: true }).catch(() => undefined);
        console.log(`[essai-crm-prod] ${SEQUENCES} : ${quoi} fait à ${new Date().toISOString()}`);
      } catch (e) {
        console.error(`[essai-crm-prod] ${SEQUENCES} : ${quoi} impossible : ${String(e).slice(0, 200)}`);
      } finally {
        await ctx.close();
      }
    };
    const jusqua = Date.now() + DUREE_ESSAI_MS;
    while (!existsSync(fin) && Date.now() < jusqua) {
      for (const quoi of ['Allumer', 'Couper'] as const) {
        const signal = join(RUN_DIR, `essai-crm-${quoi.toLowerCase()}`);
        if (existsSync(signal)) { rmSync(signal, { force: true }); await geste(quoi); }
      }
      await new Promise((ok) => setTimeout(ok, 20_000));
    }
    return `essai tenu ${existsSync(fin) ? 'jusqu\'au signal de fin' : 'jusqu\'à la limite de temps'} : tenant ${T.id}, CRM ${espaceCrm}`;
  } finally {
    rmSync(fiche, { force: true });
  }
}, { timeout: DUREE_ESSAI_MS + 30 * 60_000 });
