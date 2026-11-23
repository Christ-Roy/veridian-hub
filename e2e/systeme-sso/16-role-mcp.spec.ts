/**
 * Porte MCP : un membre de l'espace CRM à rôle restreint reste restreint (VER-203, condition de la parente).
 *
 * Le Hub n'a pas de rôle : il présente l'identité du membre (JWT ES256, sub = hub_user_id) et Twenty émet le jeton
 * natif de CE membre dans CET espace, donc son rôle s'applique. Joué sur le Hub de STAGING, dans l'espace d'épreuve du
 * CRM, rôle géré par son script (`veridian-crm-repo/scripts/ci/preuve-mcp-role.py`) :
 *   1. B attaché à l'espace (route signée attach-member) comme Member, qui lit les sociétés : find_many_companies passe ;
 *   2. B reçoit le rôle « Preuve MCP restreint » (sociétés interdites) : le même appel est refusé par Twenty, et aucun
 *      nom de société ne fuit dans aucune réponse rendue à B ;
 *   3. B redevient Member : l'appel passe de nouveau (le refus venait bien du rôle).
 * Ordre voulu : Member d'abord, car le catalogue d'outils du Hub est gardé 5 min par compte (restreint d'abord, la
 * porte dirait « outil inconnu », qui ne prouve rien).
 *
 * `twenty` n'est pas activé pour B : le Hub lui créerait son propre espace, qui pourrait devenir le sien par défaut.
 * Le registre MCP du staging est donc ouvert à tous le temps du cas (acces=tous), puis remis comme avant.
 *
 * Épreuve : `SSO_SABOTAGE=role-mcp` ne pose pas le rôle restreint : le cas doit échouer.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { admin, adminOk, appelTwenty } from './lib/hub-admin';
import { obtenirJetonMcp, outil, rpc } from './lib/mcp';
import { creerCompteProuve } from './lib/parcours';

const CRM_REPO = process.env.CRM_REPO || path.join(os.homedir(), 'Bureau/veridian-platform/veridian-crm-repo');
/** Espace d'épreuve du CRM sur staging (admin de test, 129 sociétés au 23/11). */
const ESPACE = 'cheerful-yellow-zebra';
const WS = '0e1e92ed-c8e4-4a7e-bcdd-e75f5dc0ce6b';
const TENANT_CRM = '6ca82063-e443-45a7-bae6-27a3f11118c4';
const ADMIN_ESPACE = process.env.CRM_ADMIN_ESPACE || 'brunon5robert+crm-rebond@gmail.com';
const URL_MCP_CRM = 'https://crm.staging.veridian.site/mcp';

/** Script du CRM : 0 vrai, 1 faux, 2 non abouti. */
function role(mode: string, ...args: string[]): void {
  try {
    execFileSync('python3', ['scripts/ci/preuve-mcp-role.py', mode, ESPACE, '--env', 'staging', '--email', ADMIN_ESPACE, ...args], {
      cwd: CRM_REPO, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const texte = `${err.stdout ?? ''}${err.stderr ?? ''}`.replace(/\s+/g, ' ').slice(-200);
    if (err.status === 1) throw new Error(`rôle CRM ${mode} : faux (${texte})`);
    throw new NonAbouti(`rôle CRM ${mode} : non abouti (${texte})`);
  }
}

cas('twenty', 'porte MCP : un membre à rôle restreint ne lit pas les sociétés, par la porte', async ({ browser }) => {
  if (!/staging/.test(HUB_URL)) throw new NonAbouti('cas joué sur le Hub de staging seulement (espace d\'épreuve du CRM)');
  if (!existsSync(path.join(CRM_REPO, 'scripts/ci/preuve-mcp-role.py'))) throw new NonAbouti(`${CRM_REPO} sans preuve-mcp-role.py : cas non joué`);

  // Le Hub doit signer (clé de staging) : une JWKS vide veut dire qu'aucune identité ne sera présentée.
  const jwks = await (await fetch(`${HUB_URL}/.well-known/jwks.json`)).json();
  if (!(jwks.keys?.length > 0)) throw new NonAbouti('le Hub de staging n\'a pas de clé de signature MCP (JWKS vide)');

  // `preparer` crée le rôle d'épreuve, ou le réaligne : le cas ne dépend de personne.
  role('preparer');
  const B = await creerCompteProuve(browser, 'role-mcp');
  if (!B.hubUserId) throw new NonAbouti('compte de test sans hub_user_id');

  const registre = (await adminOk<{ apps: { appKey: string; label: string; mcpUrl: string; acces: string; enabled: boolean }[] }>('GET', 'mcp-apps')).apps;
  const avant = registre.find((a) => a.appKey === 'twenty');
  const poser = (acces: string) => adminOk('POST', 'mcp-apps', { app_key: 'twenty', label: avant?.label ?? 'CRM', mcp_url: avant?.mcpUrl ?? URL_MCP_CRM, acces, enabled: avant?.enabled ?? true });
  let attache = false;
  try {
    const rep = await appelTwenty('POST', `/api/veridian/workspaces/${WS}/attach-member`, { hub_user_id: B.hubUserId, hub_user_email: B.email, role: 'member' });
    if (rep.status !== 201 && rep.status !== 200) throw new NonAbouti(`attach-member de B : HTTP ${rep.status} ${(await rep.text()).slice(0, 160)}`);
    attache = true;
    await poser('tous');

    const jeton = await obtenirJetonMcp(browser, B, 'TEST ROLE MCP');
    const liste = await rpc(jeton, 'tools/list');
    expect(liste.status, 'porte MCP ouverte à B').toBe(200);
    const outilSocietes = async () => outil(jeton, 'executer_outil', { nom: 'twenty.find_many_companies', arguments: { limit: 5, select: ['id', 'name'] } });

    // 1. Member : les sociétés se lisent (le cas a de quoi fuiter).
    const decouverte = await outil(jeton, 'chercher_outils', { besoin: 'find many companies', app: 'twenty' });
    if (!decouverte.texte.includes('twenty.find_many_companies')) throw new NonAbouti(`le CRM ne montre pas find_many_companies à B : ${decouverte.texte.slice(0, 160)}`);
    const lu = await outilSocietes();
    expect(lu.isError, `Member lit les sociétés (${lu.texte.slice(0, 160)})`).toBe(false);
    expect(lu.texte, 'Member : refus applicatif').not.toMatch(/"success":\s*false/);
    const noms = Array.from(lu.texte.matchAll(/"name":\s*"([^"]{5,})"/g), (m) => m[1]);
    if (noms.length < 3) throw new NonAbouti(`trop peu de noms de sociétés lus (${noms.length}) : un refus n'y prouverait rien`);

    // 2. Rôle restreint : refus par Twenty, et aucun nom de société nulle part.
    if (process.env.SSO_SABOTAGE !== 'role-mcp') role('attribuer', '--membre', B.email);
    const refuse = await outilSocietes();
    const recherche = await outil(jeton, 'chercher_outils', { besoin: 'find many companies', app: 'twenty' });
    const description = await outil(jeton, 'decrire_outil', { nom: 'twenty.find_many_companies' });
    const fuite = [refuse, recherche, description].flatMap((r) => noms.filter((n) => r.texte.includes(n)));
    expect(refuse.texte, 'le refus vient de Twenty (rôle), pas de la porte').toMatch(/not found|permission|FORBIDDEN|"success":\s*false/i);
    expect(refuse.texte, 'la réponse ne contient plus de société').not.toMatch(/"companies"|"totalCount"/);
    expect(fuite, 'aucun nom de société rendu à B restreint').toEqual([]);

    // 3. Retour Member : l'appel passe de nouveau.
    role('attribuer', '--membre', B.email, '--role', 'Member');
    const rendu = await outilSocietes();
    expect(rendu.isError || /"success":\s*false/.test(rendu.texte), `Member relit les sociétés (${rendu.texte.slice(0, 160)})`).toBe(false);
    return `Member lu (${noms.length} noms), restreint refusé par Twenty, 0 fuite, Member relu`;
  } finally {
    // Remise en état, quoi qu'il arrive : registre du staging, membre retiré de l'espace, compte Twenty désactivé.
    if (avant) await poser(avant.acces);
    else await admin('DELETE', 'mcp-apps?app_key=twenty');
    if (attache) {
      await appelTwenty('POST', `/api/tenants/${TENANT_CRM}/remove-member`, { email: B.email }).catch(() => null);
      await appelTwenty('POST', '/api/hub/users/sync', { hub_user_id: B.hubUserId, deleted: true }).catch(() => null);
    }
  }
}, { timeout: 600_000 });
