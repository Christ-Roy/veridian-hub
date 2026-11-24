/**
 * Mode programme de la porte MCP, sur ce qui est servi (docs/CONTRAT-MCP.md) : un client consent, lance un programme, reçoit
 * son seul résultat ; l'échéance rend un état et une reprise ; une boucle infinie ne ralentit pas /api/health.
 * L'enfermement s'éprouve à part : scripts/epreuve-programme.sh. Épreuve : `SSO_SABOTAGE=programme` (le programme ne sauve
 * rien) doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { obtenirJetonMcp, rpc } from './lib/mcp';
import { creerCompteProuve } from './lib/parcours';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sante(n: number): Promise<number[]> {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = Date.now();
    const r = await fetch(`${HUB_URL}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (r.status !== 200) throw new Error(`/api/health ${r.status}`);
    t.push(Date.now() - d);
    await dormir(150);
  }
  return t.sort((a, b) => a - b);
}

cas(null, 'porte MCP : un programme tourne, se borne, se reprend, et ne ralentit pas le Hub', async ({ browser }) => {
  const E = await creerCompteProuve(browser, 'programme');
  const jeton = await obtenirJetonMcp(browser, E, 'TEST PROGRAMME');
  const outils = (await rpc(jeton, 'tools/list')).json?.result?.tools?.map((t: { name: string }) => t.name) ?? [];
  if (!outils.includes('executer_programme')) throw new NonAbouti(`executer_programme non offert : ${outils.join(',')}`);
  const lancer = async (code: string, plus: Record<string, unknown> = {}) => {
    const r = await fetch(`${HUB_URL}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'executer_programme', arguments: { code, ...plus } } }),
      signal: AbortSignal.timeout(95_000),
    });
    expect(r.status).toBe(200);
    const t = (await r.json()).result.content[0].text as string;
    try { return JSON.parse(t); } catch { return { texte: t }; }
  };

  const un = await lancer('let n=0; for (let i=0;i<20;i++){ const c = await outil("hub.mon_compte"); if (c.email) n++; } return {n, f: typeof fetch + typeof process + typeof require}');
  if (un.raison === 'moteur_indisponible') throw new NonAbouti('moteur des programmes indisponible');
  expect(un).toMatchObject({ etat: 'termine', resultat: { n: 20, f: 'undefinedundefinedundefined' }, appels: { faits: 20, reussis: 20 } });

  // Un client qui a gardé l'ancienne liste de trois : trouvé par la recherche, joué par executer_outil.
  const cherche = JSON.parse((await rpc(jeton, 'tools/call', { name: 'chercher_outils', arguments: { besoin: 'importer des milliers de prospects en masse' } })).json.result.content[0].text);
  expect(cherche.outils.map((o: { nom: string }) => o.nom)).toContain('hub.executer_programme');
  const ancien = JSON.parse((await rpc(jeton, 'tools/call', { name: 'executer_outil', arguments: { nom: 'hub.executer_programme', arguments: { code: 'const c = await outil("hub.mon_compte"); return c.email' } } })).json.result.content[0].text);
  expect(ancien).toMatchObject({ etat: 'termine', resultat: E.email });

  const interdit = await lancer('const r=[]; for (const n of ["executer_programme","hub.executer_programme","executer_outil","hub.inconnu"]) { try { await outil(n,{}); r.push("joue") } catch(e) { r.push("refuse") } } return r', { autoriser: ['executer_programme', 'hub.executer_programme'] });
  expect(interdit.resultat).toEqual(['refuse', 'refuse', 'refuse', 'refuse']);

  // Échéance : un état, une reprise ; et un second programme du même compte est refusé pendant ce temps.
  const sauver = process.env.SSO_SABOTAGE === 'programme' ? '' : 'sauver({i});';
  const long = lancer(`for (let i=(reprise?.i ?? 0);;i++){ await outil("hub.mon_compte"); ${sauver} await pause(2000); }`);
  await dormir(3_000);
  expect(String((await lancer('return 1')).texte)).toContain('déjà en cours');
  const arrete = await long;
  expect(arrete).toMatchObject({ etat: 'interrompu', raison: 'delai' });
  expect(arrete.duree_ms).toBeLessThan(47_000);
  expect(arrete.reprise?.i, 'état de reprise rendu').toBeGreaterThan(5);
  const suite = await lancer('return reprise.i + 1', { reprise: arrete.reprise });
  expect(suite.resultat).toBe(arrete.reprise.i + 1);

  // Boucle infinie : arrêtée, et le Hub répond pareil pendant qu'elle tourne.
  const avant = await sante(20);
  const boucle = lancer('while(true){}');
  await dormir(1_000);
  const pendant = await sante(20);
  expect((await boucle).etat).toBe('erreur');
  const med = (t: number[]) => t[Math.floor(t.length / 2)];
  expect(med(pendant), `médiane /api/health ${med(avant)} ms avant, ${med(pendant)} ms pendant`).toBeLessThan(med(avant) * 2 + 60);
  return `20 appels, échéance ${arrete.duree_ms} ms avec reprise, /api/health ${med(avant)} puis ${med(pendant)} ms (max ${pendant.at(-1)})`;
}, { timeout: 400_000 });
