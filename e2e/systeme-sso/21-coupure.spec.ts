/**
 * Couper (VER-245) : un membre retiré et une organisation suspendue perdent la porte MCP en moins de 2 minutes, et le Hub dit, app
 * par app, ce qui a suivi. Comptes et espaces de test, retirés par la batterie ; staging ou prod.
 * Academy en prod seulement (le Hub de staging ne l'a pas) : retirée, relue, et une synchronisation rejouée ne rend pas l'accès.
 * Épreuve : `SSO_SABOTAGE=coupure-retrait` ne retire pas, `SSO_SABOTAGE=coupure-suspension` ne suspend pas,
 * `SSO_SABOTAGE=coupure-analytics` ne crée pas le compte Analytics : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, appelAcademy, appelTwenty, lookup, rybbitCompte } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, noterRybbit, type Compte } from './lib/parcours';

type Vue = { espaces: { slug: string; role: string }[]; espaces_suspendus?: { slug: string }[] };
const vue = async (jeton: string): Promise<Vue> => JSON.parse((await outil(jeton, 'executer_outil', { nom: 'hub.mon_compte' })).texte);
// Un outil du CRM : la seule app présente à la fois sur le staging et en prod.
const LIRE = { nom: 'twenty.find_many_people', arguments: { limit: 1, select: ['id'] } };
const dansEspace = (jeton: string, espace: string) => outil(jeton, 'executer_outil', { ...LIRE, espace });
/** Un compte avec son espace CRM, créé par le Hub, donc avec un tenant (le staging n'en crée pas à l'inscription). */
async function avecCrm(c: Compte): Promise<{ tenantId: string; espaceCrm: string }> {
  const espaceCrm = await activerTwentyAuHub(c.email);
  const tenantId = (await lookup(c.email)).json?.tenants?.[0]?.id as string | undefined;
  if (!tenantId) throw new NonAbouti('compte de test sans tenant');
  noterEspaceTwenty(c.email, tenantId);
  return { tenantId, espaceCrm };
}
async function exiger<T>(promesse: Promise<{ status: number; json: T }>, statuts: number[], quoi: string): Promise<T> {
  const r = await promesse;
  if (!statuts.includes(r.status)) throw new Error(`${quoi} : HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
const apps = (j: any) => (j.apps as { app: string; etat: string; detail?: string }[]).map((a) => `${a.app}=${a.etat}${a.detail ? ` (${a.detail})` : ''}`).join(', ');

/** Le registre MCP du staging n'a pas le CRM : posé pour ce cas, rendu tel quel. En prod, rien n'est touché. */
async function avecCrmAuRegistre<T>(jouer: () => Promise<T>): Promise<T> {
  if (!/staging/.test(HUB_URL)) return jouer();
  const avant = (await adminOk<{ apps: { appKey: string }[] }>('GET', 'mcp-apps')).apps.find((a) => a.appKey === 'twenty');
  if (avant) return jouer();
  await adminOk('POST', 'mcp-apps', { app_key: 'twenty', label: 'CRM', mcp_url: 'https://crm.staging.veridian.site/mcp', acces: 'tous', enabled: true });
  try {
    return await jouer();
  } finally {
    await admin('DELETE', 'mcp-apps?app_key=twenty');
  }
}

cas(null, 'coupure : membre retiré et organisation suspendue refusés par la porte MCP en moins de 2 min', ({ browser }) => avecCrmAuRegistre(async () => {
  const P: Compte = await creerCompteProuve(browser, 'coupprop');
  const M: Compte = await creerCompteProuve(browser, 'coupmembre');
  if (!P.hubUserId || !M.hubUserId) throw new NonAbouti('comptes de test incomplets');
  const { tenantId: TENANT, espaceCrm } = await avecCrm(P);
  await avecCrm(M);
  const jetonP = await obtenirJetonMcp(browser, P, 'TEST COUPURE P');
  const jetonM = await obtenirJetonMcp(browser, M, 'TEST COUPURE M');
  for (const j of [jetonP, jetonM]) {
    const d = await outil(j, 'chercher_outils', { besoin: 'find many people', app: 'twenty' });
    if (!d.texte.includes(LIRE.nom)) throw new NonAbouti(`le CRM ne montre pas ${LIRE.nom} : ${d.texte.slice(0, 300)}`);
  }
  // Un programme n'écrit pas au CRM sans nommer l'outil : Twenty dit « non destructif » de toutes ses écritures (24/11). La lecture passe.
  if (!/staging/.test(HUB_URL)) {
    const code = 'const r={}; for (const n of ["twenty.find_many_people","twenty.create_one_person","twenty.create_webhook"]) { try { await outil(n,{limit:1,select:["id"]}); r[n]="joue" } catch(e) { r[n]=/jamais depuis un programme, même nommé/.test(e.message) ? "reserve" : /autoriser/.test(e.message) ? "a_nommer" : e.message.slice(0,120) } } return r';
    const jouer = async (autoriser?: string[]) => {
      const prog = JSON.parse((await outil(jetonP, 'executer_programme', { code, ...(autoriser ? { autoriser } : {}) })).texte);
      if (prog.etat !== 'termine') throw new NonAbouti(`programme : ${JSON.stringify(prog).slice(0, 200)}`);
      return prog.resultat;
    };
    const attendu = { 'twenty.find_many_people': 'joue', 'twenty.create_one_person': 'a_nommer', 'twenty.create_webhook': 'reserve' };
    expect(await jouer()).toEqual(attendu);
    // Administrer (webhooks, clés, membres...) : jamais depuis un programme, MÊME nommé (VER-253).
    expect(await jouer(['twenty.create_webhook']), 'nommé').toEqual(attendu);
  }
  const slugP = (await vue(jetonP)).espaces[0]?.slug;
  const slugM = (await vue(jetonM)).espaces[0]?.slug;
  if (!slugP || !slugM) throw new NonAbouti('espace de test sans slug');

  // Avant : M n'y est pas. Membre : il y est. C'est la preuve positive, sans quoi le refus final ne prouverait rien.
  const etranger = await dansEspace(jetonM, slugP);
  expect(etranger.texte, `étranger : ${etranger.texte.slice(0, 200)}`).toContain('inconnu pour ce compte');
  const ajout = await exiger(admin('POST', `tenants/${TENANT}/members`, { hub_user_id: M.hubUserId }), [200, 207], 'ajout'); // 207 : le CRM ne sert pas encore le rôle
  expect(ajout).toMatchObject({ cree: true, role: 'member' });
  expect((await vue(jetonM)).espaces.map((e) => e.slug), 'membre').toContain(slugP);
  const entree = await appelTwenty('POST', `/api/veridian/workspaces/${espaceCrm}/attach-member`, { hub_user_id: M.hubUserId, hub_user_email: M.email, role: 'member' });
  if (!entree.ok) throw new NonAbouti(`entrée au CRM : HTTP ${entree.status}`);
  expect((await dansEspace(jetonM, slugP)).texte, 'membre : la porte ne refuse plus').not.toMatch(/inconnu pour ce compte|suspendu/);

  const academy = !/staging/.test(HUB_URL);
  const rejoint = new Date();
  const syncAcademy = async (joined_at?: string) => {
    const r = await appelAcademy(`/api/tenants/${TENANT}/sync-member`, { hub_user_id: M.hubUserId, email: M.email, role: 'member', email_proven: true, ...(joined_at ? { joined_at } : {}) });
    return [r.status, ((await r.json().catch(() => null)) as { error?: string } | null)?.error];
  };
  if (academy) {
    await exiger(admin('POST', 'tenants/app-access', { user_email: P.email, app: 'academy', enabled: true }), [200], 'activation Academy');
    expect(await syncAcademy(rejoint.toISOString()), 'entrée à Academy').toEqual([200, undefined]);
  }

  // M a un compte chez Analytics, qui n'a pas de route de retrait (VER-260) : le retrait doit le DIRE, jamais « absent ». P n'en a pas : témoin.
  if (academy && process.env.SSO_SABOTAGE !== 'coupure-analytics') {
    noterRybbit(M.email);
    rybbitCompte('creer', M.email);
  }

  // Le propriétaire ne se retire pas.
  expect((await admin<any>('POST', `tenants/${TENANT}/remove-member`, { hub_user_id: P.hubUserId })).json.error).toBe('cannot_remove_owner');

  const t0 = Date.now();
  const retrait = process.env.SSO_SABOTAGE === 'coupure-retrait' ? { apps: [] } : await exiger<any>(admin('POST', `tenants/${TENANT}/remove-member`, { hub_user_id: M.hubUserId }), [200, 207], 'retrait');
  const refus = await dansEspace(jetonM, slugP);
  const coupe = Date.now() - t0;
  expect(refus.isError, refus.texte.slice(0, 200)).toBe(true);
  expect(refus.texte).toContain('inconnu pour ce compte');
  expect(coupe).toBeLessThan(120_000);
  expect((retrait.apps as { app: string; etat: string }[]).find((a) => a.app === 'crm')?.etat, `le CRM a retiré, et a été relu : ${apps(retrait)}`).toBe('retire');
  if (academy) {
    expect([(retrait.apps as { app: string; etat: string; detail?: string }[]).filter((a) => a.app === 'analytics' && a.etat === 'non_gere' && /^NON FERMÉ/.test(a.detail ?? '')).length, /PAS coupé : analytics \(NON FERMÉ/.test(retrait.avis ?? ''), retrait.complet], `Analytics, dit non fermé : ${apps(retrait)} ; avis ${retrait.avis}`).toEqual([1, true, false]);
    expect((retrait.apps as { app: string; etat: string }[]).find((a) => a.app === 'academy')?.etat, `Academy a retiré, et a été relue : ${apps(retrait)}`).toBe('retire');
    expect([await syncAcademy(), await syncAcademy(rejoint.toISOString())], 'Academy : un rejeu ne rend pas l\'accès').toEqual([[409, 'member_removed'], [409, 'member_removed']]);
    expect(await syncAcademy(new Date().toISOString()), 'Academy : une adhésion postérieure, si').toEqual([200, undefined]);
  }
  expect((await vue(jetonM)).espaces.map((e) => e.slug), 'retiré').not.toContain(slugP);
  expect((await vue(jetonM)).espaces.map((e) => e.slug), 'son propre espace reste').toContain(slugM);

  // Le retrait tient : une réconciliation ne rend rien, et même une app qui le remettrait (sync-member) ne rouvre pas la porte.
  await admin('POST', 'reconcile-trigger');
  await appelTwenty('POST', `/api/tenants/${TENANT}/sync-member`, { hub_user_id: M.hubUserId, email: M.email, user_email: M.email, role: 'member' });
  expect((await dansEspace(jetonM, slugP)).texte, 'retrait tenu').toContain('inconnu pour ce compte');
  const rejeu = await exiger<any>(admin('POST', `tenants/${TENANT}/remove-member`, { hub_user_id: M.hubUserId }), [200, 207], 'rejeu du retrait');
  expect(rejeu.deja).toBe(true);
  expect(rejeu.apps.find((a: { app: string }) => a.app === 'crm')?.etat, `rejeu : ${apps(rejeu)}`).toMatch(/^(retire|absent)$/);
  if (academy) expect(rejeu.apps.find((a: { app: string }) => a.app === 'academy')?.etat, `rejeu : ${apps(rejeu)}`).toBe('retire');

  const t1 = Date.now();
  const susp = process.env.SSO_SABOTAGE === 'coupure-suspension' ? { apps: [] } : await exiger<any>(admin('POST', `tenants/${TENANT}/suspension`, { suspendre: true, motif: 'test' }), [200, 207], 'suspension');
  for (const r of [await dansEspace(jetonP, slugP), await outil(jetonP, 'executer_outil', LIRE), await outil(jetonP, 'executer_programme', { code: 'return 1' })]) {
    expect(r.isError, r.texte.slice(0, 200)).toBe(true);
    expect(r.texte).toContain('suspendu');
  }
  const coupeSusp = Date.now() - t1;
  expect(coupeSusp).toBeLessThan(120_000);
  if (academy) expect((susp.apps as { app: string; etat: string }[]).find((a) => a.app === 'analytics')?.etat ?? 'absent', 'témoin : sans compte, Analytics est absent').toBe('absent');
  expect((await vue(jetonP)).espaces_suspendus?.map((e) => e.slug), 'mon_compte le dit').toEqual([slugP]);
  expect((await dansEspace(jetonM, slugM)).texte, 'un autre tenant n\'est pas touché').not.toContain('suspendu');

  const reprise = await exiger<any>(admin('POST', `tenants/${TENANT}/suspension`, { suspendre: false }), [200, 207], 'reprise');
  // Tout ce qui a été suspendu est repris, même chez une app qui cache un espace suspendu (Prospection, 24/11).
  for (const a of (susp.apps as { app: string; etat: string }[]).filter((x) => x.etat === 'suspendu')) {
    expect((reprise.apps as { app: string; etat: string }[]).find((x) => x.app === a.app)?.etat, `reprise de ${a.app} : ${apps(reprise)}`).toBe('repris');
  }
  expect((await dansEspace(jetonP, slugP)).texte, 'reprise').not.toContain('suspendu');
  return `retrait coupé en ${coupe} ms [${apps(retrait)}] ; suspension en ${coupeSusp} ms [${apps(susp)}] ; reprise [${apps(reprise)}]`;
}), { timeout: 420_000 });
