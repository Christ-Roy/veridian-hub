/**
 * Couper (VER-245) : un membre retiré et une organisation suspendue perdent la porte MCP en moins de 2 minutes, et le Hub dit, app
 * par app, ce qui a suivi. Comptes et espaces de test, retirés par la batterie ; staging ou prod.
 * Épreuve : `SSO_SABOTAGE=coupure-retrait` ne retire pas, `SSO_SABOTAGE=coupure-suspension` ne suspend pas : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { cas, NonAbouti } from './lib/etat';
import { admin } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, type Compte } from './lib/parcours';

type Vue = { espaces: { slug: string; role: string }[]; espaces_suspendus?: { slug: string }[] };
const vue = async (jeton: string): Promise<Vue> => JSON.parse((await outil(jeton, 'executer_outil', { nom: 'hub.mon_compte' })).texte);
const dansEspace = (jeton: string, espace: string) => outil(jeton, 'executer_outil', { nom: 'notifuse.contacts_list', arguments: {}, espace });
async function exiger<T>(promesse: Promise<{ status: number; json: T }>, statuts: number[], quoi: string): Promise<T> {
  const r = await promesse;
  if (!statuts.includes(r.status)) throw new Error(`${quoi} : HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
const apps = (j: any) => (j.apps as { app: string; etat: string; detail?: string }[]).map((a) => `${a.app}=${a.etat}${a.detail ? ` (${a.detail})` : ''}`).join(', ');

cas(null, 'coupure : membre retiré et organisation suspendue refusés par la porte MCP en moins de 2 min', async ({ browser }) => {
  const P: Compte = await creerCompteProuve(browser, 'coupprop');
  const M: Compte = await creerCompteProuve(browser, 'coupmembre');
  if (!P.tenantId || !M.hubUserId) throw new NonAbouti('comptes de test incomplets');
  const jetonP = await obtenirJetonMcp(browser, P, 'TEST COUPURE P');
  const jetonM = await obtenirJetonMcp(browser, M, 'TEST COUPURE M');
  const slugP = (await vue(jetonP)).espaces[0]?.slug;
  const slugM = (await vue(jetonM)).espaces[0]?.slug;
  if (!slugP || !slugM) throw new NonAbouti('espace de test sans slug');

  // Avant : M n'y est pas. Membre : il y est. C'est la preuve positive, sans quoi le refus final ne prouverait rien.
  expect((await dansEspace(jetonM, slugP)).texte, 'étranger').toContain('inconnu pour ce compte');
  const ajout = await exiger(admin('POST', `tenants/${P.tenantId}/members`, { hub_user_id: M.hubUserId }), [200], 'ajout');
  expect(ajout).toEqual({ cree: true, role: 'member' });
  expect((await vue(jetonM)).espaces.map((e) => e.slug), 'membre').toContain(slugP);
  expect((await dansEspace(jetonM, slugP)).texte, 'membre : la porte ne refuse plus').not.toMatch(/inconnu pour ce compte|suspendu/);

  // Le propriétaire ne se retire pas.
  expect((await admin<any>('POST', `tenants/${P.tenantId}/remove-member`, { hub_user_id: P.hubUserId })).json.error).toBe('cannot_remove_owner');

  const t0 = Date.now();
  const retrait = process.env.SSO_SABOTAGE === 'coupure-retrait' ? { apps: [] } : await exiger<any>(admin('POST', `tenants/${P.tenantId}/remove-member`, { hub_user_id: M.hubUserId }), [200, 207], 'retrait');
  const refus = await dansEspace(jetonM, slugP);
  const coupe = Date.now() - t0;
  expect(refus.isError, refus.texte.slice(0, 200)).toBe(true);
  expect(refus.texte).toContain('inconnu pour ce compte');
  expect(coupe).toBeLessThan(120_000);
  expect((await vue(jetonM)).espaces.map((e) => e.slug), 'retiré').not.toContain(slugP);
  expect((await vue(jetonM)).espaces.map((e) => e.slug), 'son propre espace reste').toContain(slugM);

  const t1 = Date.now();
  const susp = process.env.SSO_SABOTAGE === 'coupure-suspension' ? { apps: [] } : await exiger<any>(admin('POST', `tenants/${P.tenantId}/suspension`, { suspendre: true, motif: 'test' }), [200, 207], 'suspension');
  for (const r of [await dansEspace(jetonP, slugP), await outil(jetonP, 'executer_outil', { nom: 'notifuse.contacts_list', arguments: {} }), await outil(jetonP, 'executer_programme', { code: 'return 1' })]) {
    expect(r.isError, r.texte.slice(0, 200)).toBe(true);
    expect(r.texte).toContain('suspendu');
  }
  const coupeSusp = Date.now() - t1;
  expect(coupeSusp).toBeLessThan(120_000);
  expect((await vue(jetonP)).espaces_suspendus?.map((e) => e.slug), 'mon_compte le dit').toEqual([slugP]);
  expect((await dansEspace(jetonM, slugM)).texte, 'un autre tenant n\'est pas touché').not.toContain('suspendu');

  const reprise = await exiger<any>(admin('POST', `tenants/${P.tenantId}/suspension`, { suspendre: false }), [200, 207], 'reprise');
  expect((await dansEspace(jetonP, slugP)).texte, 'reprise').not.toContain('suspendu');
  return `retrait coupé en ${coupe} ms [${apps(retrait)}] ; suspension en ${coupeSusp} ms [${apps(susp)}] ; reprise [${apps(reprise)}]`;
}, { timeout: 420_000 });
