/**
 * Rôle d'organisation porté par le Hub (VER-245 b.1, contrat §5.19.4), par la vraie porte MCP : un membre n'installe pas d'app dans le
 * CRM, promu au Hub il installe, rétrogradé il ne peut plus, son propre espace reste intact, et une version rejouée ne rend rien.
 * Épreuve : `SSO_SABOTAGE=role-promotion` ne promeut pas, `SSO_SABOTAGE=role-retrograde` ne rétrograde pas : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, appelTwenty, lookup, marquerTest } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';

/** L'app « Liaisons », listée au catalogue du CRM. */
const LIAISONS = '1a1ab23e-60e5-4eca-be1f-718c96055c79';

cas(null, 'rôle : le Hub promeut, le CRM laisse installer ; il rétrograde, le CRM refuse', async ({ browser }) => {
  const staging = /staging/.test(HUB_URL);
  const avant = staging ? (await adminOk<{ apps: { appKey: string }[] }>('GET', 'mcp-apps')).apps.find((a) => a.appKey === 'twenty') : true;
  if (!avant) await adminOk('POST', 'mcp-apps', { app_key: 'twenty', label: 'CRM', mcp_url: 'https://crm.staging.veridian.site/mcp', acces: 'tous', enabled: true });
  try {
    const espace = async (c: Compte) => {
      const crm = await activerTwentyAuHub(c.email);
      const t = (await lookup(c.email)).json?.tenants?.[0];
      if (!t) throw new NonAbouti('compte de test sans tenant');
      noterEspaceTwenty(c.email, t.id);
      return { id: t.id as string, slug: t.slug as string, crm };
    };
    const P: Compte = await creerCompteProuve(browser, 'roleprop');
    const M: Compte = await creerCompteProuve(browser, 'rolemembre');
    const T = await espace(P);
    await marquerTest(T.id);
    const V = await espace(M);
    await adminOk('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId });
    const entree = await appelTwenty('POST', `/api/veridian/workspaces/${T.crm}/attach-member`, { hub_user_id: M.hubUserId, hub_user_email: M.email, role: 'member' });
    if (!entree.ok) throw new NonAbouti(`entrée au CRM : HTTP ${entree.status}`);

    const jeton = await obtenirJetonMcp(browser, M, 'TEST ROLE');
    const installer = (ou: string) => outil(jeton, 'executer_outil', { nom: 'twenty.install_app', arguments: { universalIdentifier: LIAISONS }, espace: ou });
    const refuse = async (quand: string, ou = T.slug) => {
      const r = await installer(ou);
      expect(r.isError, `${quand} : ${r.texte.slice(0, 300)}`).toBe(true);
      expect(r.texte, `${quand} : un refus de droit, pas une panne`).not.toMatch(/already|déjà install|ne répond pas|injoignable|inconnu pour ce compte/i);
      return r.texte.slice(0, 120);
    };
    const accepte = async (quand: string, ou = T.slug) => {
      const r = await installer(ou);
      expect(r.isError, `${quand} : ${r.texte.slice(0, 300)}`).toBe(false);
    };
    const poser = (role: 'admin' | 'member') => admin<{ role: string; apps: { app: string; etat: string; detail?: string }[] }>('POST', `tenants/${T.id}/members`, { hub_user_id: M.hubUserId, role });

    const motif = await refuse('membre');
    if (process.env.SSO_SABOTAGE !== 'role-promotion') {
      const promu = await poser('admin');
      expect([promu.status, promu.json.apps], JSON.stringify(promu.json).slice(0, 300)).toEqual([200, [{ app: 'crm', etat: 'applique' }]]);
    }
    const t0 = Date.now();
    await accepte('promu');
    const effet = Date.now() - t0;
    const version = Date.now();
    if (process.env.SSO_SABOTAGE !== 'role-retrograde') {
      const rendu = await poser('member');
      expect([rendu.status, rendu.json.apps], JSON.stringify(rendu.json).slice(0, 300)).toEqual([200, [{ app: 'crm', etat: 'applique' }]]);
    }
    await refuse('rétrogradé');
    await accepte('son propre espace est intact', V.slug);

    // Une version d'avant la rétrogradation, signée comme le Hub le ferait : sans effet.
    const rejeu = await appelTwenty('POST', '/api/hub/members/role', { hub_tenant_id: T.id, hub_user_id: M.hubUserId, email: M.email, role: 'admin', version: version - 60_000 });
    expect([rejeu.status, await rejeu.json()], 'version rejouée').toEqual([200, expect.objectContaining({ applied: false, reason: 'stale' })]);
    await refuse('après le rejeu');
    return `membre refusé (« ${motif} ») ; promu installe en ${effet} ms ; rétrogradé refusé ; espace voisin intact ; version rejouée : stale`;
  } finally {
    if (!avant) await admin('DELETE', 'mcp-apps?app_key=twenty');
  }
}, { timeout: 480_000 });
