/**
 * L'API du CRM dans un programme (VER-253) : api_lire passe, api_ecrire et api_supprimer se NOMMENT, et rien de ce qui administre (membres)
 * ne passe par elles, même nommées, ni par alias, ni en écriture glissée dans une lecture, ni en masse sans liste d'identifiants.
 * `SSO_RAISONS=<fichier>` y écrit la raison de chaque refus. Épreuve : `SSO_SABOTAGE=api-crm` ne nomme pas l'écriture : le cas doit échouer.
 */
import { writeFileSync } from 'node:fs';

import { expect } from '@playwright/test';

import { cas, NonAbouti } from './lib/etat';
import { activerTwentyAuHub, admin, adminOk, lookup } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve, noterEspaceTwenty, type Compte } from './lib/parcours';
import { HUB_URL } from './lib/cibles';

cas(null, 'API du CRM dans un programme : lire passe, écrire se nomme, administrer ne passe jamais', async ({ browser }) => {
  const staging = /staging/.test(HUB_URL);
  const avant = staging ? (await adminOk<{ apps: { appKey: string }[] }>('GET', 'mcp-apps')).apps.some((a) => a.appKey === 'twenty') : true;
  if (!avant) await adminOk('POST', 'mcp-apps', { app_key: 'twenty', label: 'CRM', mcp_url: 'https://crm.staging.veridian.site/mcp', acces: 'tous', enabled: true });
  try {
    const P: Compte = await creerCompteProuve(browser, 'apicrm');
    await activerTwentyAuHub(P.email);
    const T = (await lookup(P.email)).json?.tenants?.[0];
    if (!T) throw new NonAbouti('compte de test sans tenant');
    noterEspaceTwenty(P.email, T.id);
    const jeton = await obtenirJetonMcp(browser, P, 'TEST API CRM');
    const decrits = await outil(jeton, 'decrire_outil', { nom: 'twenty.api_lire' });
    if (decrits.isError) throw new NonAbouti(`twenty.api_lire n'est pas servi : ${decrits.texte.slice(0, 200)}`);

    /** Joue des étapes [outil, query, variables] et rend pour chacune : ok + données, a_nommer, reserve, ou le refus de l'app. */
    const jouer = async (etapes: [string, string, object?][], autoriser: string[] = []) => {
      const code = `const r=[]; for (const [n,query,variables] of ${JSON.stringify(etapes)}) { try { const x=await outil("twenty."+n,{query,...(variables?{variables}:{})}); const t=JSON.stringify(x).replace(/\\\\"/g,'"'); r.push(/"success"\\s*:\\s*false|"ok"\\s*:\\s*false/.test(t) ? "refus : "+t.slice(0,300) : "ok : "+t.slice(0,1500)) } catch(e) { r.push(/jamais depuis un programme/.test(e.message) ? "reserve" : /autoriser/.test(e.message) ? "a_nommer" : "refus : "+e.message.slice(0,300)) } } return r`;
      const p = JSON.parse((await outil(jeton, 'executer_programme', { code, espace: T.slug, ...(autoriser.length ? { autoriser } : {}) })).texte);
      if (p.etat !== 'termine') throw new NonAbouti(`programme : ${JSON.stringify(p).slice(0, 300)}`);
      return p.resultat as string[];
    };
    const NOMS = process.env.SSO_SABOTAGE === 'api-crm' ? ['twenty.api_supprimer'] : ['twenty.api_ecrire', 'twenty.api_supprimer'];
    const CREER = 'mutation C($data: CompanyCreateInput!) { createCompany(data: $data) { id name } }';
    const LIRE = 'query L { companies(first: 60) { edges { node { id name } } } }';
    const nom = `TEST API ${Date.now().toString(36)}`;

    // Sans rien nommer : lire passe, écrire et supprimer se nomment.
    const nus = await jouer([['api_lire', LIRE], ['api_ecrire', CREER, { data: { name: nom } }], ['api_supprimer', 'mutation { deleteCompany(id: "00000000-0000-4000-8000-000000000000") { id } }']]);
    expect([nus[0].slice(0, 4), nus[1], nus[2]], nus.join(' | ').slice(0, 600)).toEqual(['ok :', 'a_nommer', 'a_nommer']);
    expect(nus[0], 'rien n\'a été créé').not.toContain(nom);

    // Nommées : une fiche créée, modifiée, relue, supprimée.
    const [creee] = await jouer([['api_ecrire', CREER, { data: { name: nom } }]], NOMS);
    const id = /"id\\*":\s*\\*"([0-9a-f-]{36})/.exec(creee)?.[1];
    expect(id, `créée : ${creee.slice(0, 400)}`).toBeTruthy();
    const suite = await jouer([
      ['api_ecrire', 'mutation U($id: UUID!, $data: CompanyUpdateInput!) { updateCompany(id: $id, data: $data) { id name } }', { id, data: { name: `${nom} modifiée` } }],
      ['api_lire', LIRE],
      ['api_supprimer', 'mutation D($id: UUID!) { deleteCompany(id: $id) { id } }', { id }],
      ['api_lire', LIRE],
    ], NOMS);
    expect(suite.map((x) => x.slice(0, 2)), suite.join(' | ').slice(0, 800)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect([suite[1].includes(`${nom} modifiée`), suite[3].includes(nom)], 'relue modifiée, puis absente').toEqual([true, false]);

    // Administrer, même nommé : le membre existe vraiment, sans quoi un refus ne prouverait rien.
    const membres = (await outil(jeton, 'executer_outil', { nom: 'twenty.find_many_workspace_members', arguments: { limit: 5, select: ['id'] }, espace: T.slug })).texte;
    const membre = /"id\\*":\s*\\*"([0-9a-f-]{36})/.exec(membres)?.[1];
    if (!membre) throw new NonAbouti(`membre du CRM illisible : ${membres.slice(0, 200)}`);
    const interdits: [string, string, object?][] = [
      ['api_ecrire', 'mutation U($id: UUID!) { updateWorkspaceMember(id: $id, data: { locale: "fr-FR" }) { id } }', { id: membre }],
      ['api_ecrire', 'mutation U($id: UUID!) { x: updateWorkspaceMember(id: $id, data: { locale: "fr-FR" }) { id } }', { id: membre }],
      ['api_supprimer', 'mutation D($id: UUID!) { deleteWorkspaceMember(id: $id) { id } }', { id: membre }],
      ['api_supprimer', 'mutation D($id: UUID!) { destroyWorkspaceMember(id: $id) { id } }', { id: membre }],
      ['api_supprimer', 'mutation D($ids: [UUID!]) { deleteWorkspaceMembers(filter: { id: { in: $ids } }) { id } }', { ids: [membre] }],
      ['api_ecrire', 'mutation { createConnectedAccount(data: { handle: "x" }) { id } }'],
      ['api_ecrire', 'mutation { createWorkflow(data: { name: "x" }) { id } }'],
      ['api_lire', CREER, { data: { name: `${nom} glissée` } }],
      ['api_ecrire', 'mutation { deleteCompany(id: "00000000-0000-4000-8000-000000000000") { id } }'],
      ['api_supprimer', 'mutation { deleteCompanies(filter: { name: { like: "%" } }) { id } }'],
      ['api_ecrire', 'mutation A { createCompany(data: { name: "a" }) { id } b: updateWorkspaceMember(id: "00000000-0000-4000-8000-000000000000", data: { locale: "fr-FR" }) { id } }'],
      ['api_lire', 'query { __schema { types { name } } }'],
    ];
    const refus = await jouer(interdits, ['twenty.api_ecrire', 'twenty.api_supprimer']);
    expect(refus.map((x, i) => [interdits[i][1].slice(0, 70), /^(refus|reserve)/.test(x)]), refus.join('\n').slice(0, 1500)).toEqual(interdits.map((x) => [x[1].slice(0, 70), true]));
    if (process.env.SSO_RAISONS) writeFileSync(process.env.SSO_RAISONS, refus.map((x, i) => `${interdits[i][0]} ${interdits[i][1].slice(0, 60)} => ${x}`).join('\n'));
    const [fin] = await jouer([['api_lire', LIRE]]);
    expect(fin, 'rien de glissé').not.toContain(`${nom} glissée`);
    expect((await outil(jeton, 'executer_outil', { nom: 'twenty.find_many_workspace_members', arguments: { limit: 5, select: ['id'] }, espace: T.slug })).texte, 'le membre est toujours là').toContain(membre);
    return `lire passe ; écrire et supprimer se nomment ; créée, modifiée, supprimée ; ${interdits.length} interdits refusés, membre intact`;
  } finally {
    if (!avant) await admin('DELETE', 'mcp-apps?app_key=twenty');
  }
}, { timeout: 480_000 });
