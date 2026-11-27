/**
 * Essai commun CRM vers Mail (VER-245, portées) : le Hub fait naître une personne d'épreuve, propriétaire, avec son espace CRM (par le Hub) et son
 * espace Mail relié ; le CRM y installe Liaisons et CLIQUE dans l'écran (aucune entrée directe chez lui) ; le Hub éteint puis rallume
 * `crm>notifuse#sequences`. Staging seulement. Le compte vit le temps de l'essai, puis la batterie le retire comme tous les siens.
 * Fiche de l'essai (adresse, mot de passe, identifiants) : ~/credentials/essai-crm-staging.json, droits 600, jamais dans le dépôt ni dans un message.
 * Fin : créer `.run/essai-crm-fin` (ou `SSO_ESSAI_MINUTES`, 180 par défaut). Prospection n'existe pas en staging : crm>prospection n'est pas joué ici.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_URL, HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, adminOk, lookup, secretServiStaging } from './lib/hub-admin';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';
import { RUN_DIR } from './lib/versions';
import { signatureVersApp } from './lib/signature-app';

const SEQUENCES = 'crm>notifuse#sequences';


/** Durée de l'essai ; le délai du test en découle (+30 min de ménage). 26/11 : délai figé à 3 h pour un essai annoncé 12 h, l'organisation de
 * Mail A a été retirée en plein travail par le nettoyage de fin de batterie. */
const DUREE_ESSAI_MS = Number(process.env.SSO_ESSAI_MINUTES ?? 180) * 60_000;

cas(null, 'essai commun : une personne née au Hub, CRM et Mail reliés, le CRM clique ses liaisons', async ({ browser }) => {
  if (!/staging/.test(HUB_URL)) throw new NonAbouti('essai commun : staging seulement');
  const MAIL = /staging/.test(APP_URL.notifuse) ? APP_URL.notifuse : 'https://notifuse.staging.veridian.site';
  const secret = secretServiStaging('NOTIFUSE_HUB_API_SECRET');
  const versMail = async (methode: string, chemin: string, corps?: object) => {
    const body = corps ? JSON.stringify(corps) : '';
    const r = await fetch(`${MAIL}${chemin}`, { method: methode, headers: { 'content-type': 'application/json', ...signatureVersApp('notifuse', secret, methode, `${MAIL}${chemin}`, body) }, body: body || undefined });
    return { status: r.status, texte: (await r.text()).slice(0, 300) };
  };
  const fiche = join(homedir(), 'credentials', 'essai-crm-staging.json');
  const fin = join(RUN_DIR, 'essai-crm-fin');
  const slug = `e2ecrm${Date.now().toString(36)}`;
  let cree = false;
  rmSync(fin, { force: true });
  try {
    const P: Compte = await creerCompteProuve(browser, 'essaicrm');
    const espaceCrm = await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0];
    if (!T) throw new NonAbouti('compte d\'essai sans tenant');
    noterEspaceTwenty(P.email, T.id);
    const prov = await versMail('POST', '/api/tenants/provision', { tenant_id: slug, owner_email: P.email, owner_hub_user_id: P.hubUserId, workspace_name: 'TEST essai CRM', plan: 'free', email_proven: true, metadata: { hub_user_id: P.hubUserId, hub_tenant_id: T.id }, hub_tenant_id: T.id });
    if (prov.status >= 300) throw new NonAbouti(`espace Mail de staging : HTTP ${prov.status} ${prov.texte}`);
    cree = true;
    // Mail ne relie l'espace à l'organisation que par update-plan (comme le cas 25) : sans cela, ses actions rendent 409 espace_non_relie.
    const lien = await versMail('POST', '/api/tenants/update-plan', { tenant_id: slug, plan: 'free', hub_tenant_id: T.id });
    if (lien.status >= 300) throw new NonAbouti(`lien de l'espace Mail : HTTP ${lien.status} ${lien.texte}`);
    // Le Hub doit SAVOIR que Mail est ouvert : sans cela, crm>notifuse n'est pas allumée par défaut (vu le 26/11, essai éteint à tort).
    await adminOk('POST', 'tenants/link-app', { user_email: P.email, app: 'notifuse', external_tenant_id: slug, external_tenant_slug: slug, tenant_name: 'TEST essai CRM', plan: 'free', provisioning_source: 'essai-48' });
    writeFileSync(fiche, JSON.stringify({ hub: HUB_URL, email: P.email, mot_de_passe: P.motDePasse, hub_user_id: P.hubUserId, hub_tenant_id: T.id, espace_crm: espaceCrm, espace_mail: slug, cree_le: new Date().toISOString() }, null, 1), { mode: 0o600 });
    console.log(`[essai-crm] prêt : espace CRM ${espaceCrm}, tenant ${T.id}, espace Mail ${slug} ; fiche ${fiche}`);
    const jusqua = Date.now() + DUREE_ESSAI_MS;
    // Le propriétaire, dans SON écran Liaisons, allume ou coupe #sequences quand un signal est posé (`.run/essai-crm-allumer` ou `-couper`).
    const geste = async (quoi: 'Allumer' | 'Couper') => {
      const ctx = await browser.newContext({ storageState: P.etat as never });
      try {
        const page = await ctx.newPage();
        await page.goto(`${HUB_URL}/dashboard/liaisons`, { waitUntil: 'networkidle' });
        await page.locator('form', { has: page.locator(`input[name="paire"][value="${SEQUENCES}"]`) }).getByRole('button', { name: quoi }).click();
        if (quoi === 'Allumer') { await page.waitForURL(/\/liaisons\/confirmer\//); await page.getByRole('button', { name: 'Allumer' }).click(); }
        await page.waitForLoadState('networkidle');
        console.log(`[essai-crm] ${SEQUENCES} : ${quoi} fait à ${new Date().toISOString()}`);
      } catch (e) {
        console.error(`[essai-crm] ${SEQUENCES} : ${quoi} impossible : ${String(e).slice(0, 200)}`);
      } finally {
        await ctx.close();
      }
    };
    while (!existsSync(fin) && Date.now() < jusqua) {
      for (const quoi of ['Allumer', 'Couper'] as const) {
        const signal = join(RUN_DIR, `essai-crm-${quoi.toLowerCase()}`);
        if (existsSync(signal)) { rmSync(signal, { force: true }); await geste(quoi); }
      }
      await fetch(`${HUB_URL}/login`).catch(() => undefined); // Sablier endort le staging après 30 min sans requête
      await new Promise((ok) => setTimeout(ok, 20_000));
    }
    return `essai tenu ${existsSync(fin) ? 'jusqu\'au signal de fin' : 'jusqu\'à la limite de temps'} : espace CRM ${espaceCrm}, Mail ${slug}`;
  } finally {
    rmSync(fiche, { force: true });
    if (cree) {
      const d = await versMail('DELETE', `/api/tenants/${slug}`);
      if (d.status >= 300 && d.status !== 404) console.error(`espace Mail ${slug} non retiré : HTTP ${d.status}`);
    }
  }
}, { timeout: DUREE_ESSAI_MS + 30 * 60_000 });
