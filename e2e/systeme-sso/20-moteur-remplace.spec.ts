/**
 * Le moteur des programmes remplacé PENDANT un programme (mise à jour, nœud perdu) : le client reçoit un état et sa reprise,
 * jamais un silence ; le Hub répond pareil ; le moteur revient et la reprise va au bout.
 * Arrête l'allocation `programme` du job hub, donc seulement sur demande : `SSO_MOTEUR_REMPLACE=1`, depuis le bastion.
 * Épreuve : `SSO_SABOTAGE=moteur-remplace` n'arrête rien : le cas doit échouer (le programme finit normalement).
 */
import { execFileSync } from 'node:child_process';

import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { adminOk } from './lib/hub-admin';
import { cas, NonAbouti } from './lib/etat';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve } from './lib/parcours';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function nomad(...args: string[]): string {
  // Arrêter une allocation demande un jeton étroit, donné par SSO_NOMAD_ALLOC_TOKEN ; jamais celui de management (24/11).
  const jeton = args[0] === 'alloc' ? process.env.SSO_NOMAD_ALLOC_TOKEN : process.env.NOMAD_TOKEN;
  if (!jeton) throw new NonAbouti('jeton Nomad étroit absent (SSO_NOMAD_ALLOC_TOKEN pour arrêter le moteur)');
  return execFileSync('nomad', args, { env: { ...process.env, NOMAD_TOKEN: jeton } as NodeJS.ProcessEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
const TOURS = 50;
const allocProgramme = () => nomad('job', 'status', 'hub').split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[2] === 'programme' && c[4] === 'run' && c[5] === 'running')?.[0];

cas(null, 'porte MCP : le moteur remplacé pendant un programme rend un état et une reprise, puis revient', async ({ browser }) => {
  if (process.env.SSO_MOTEUR_REMPLACE !== '1' || /staging/.test(HUB_URL)) throw new NonAbouti('arrête le moteur de prod : SSO_MOTEUR_REMPLACE=1 bash scripts/test-systeme-sso.sh 20-');
  const E = await creerCompteProuve(browser, 'moteur');
  const jeton = await obtenirJetonMcp(browser, E, 'TEST MOTEUR');
  const lancer = async (reprise?: unknown) => {
    const r = await outil(jeton, 'executer_programme', {
      // 50 tours (~35 s, sous l'échéance de 45 s) : à 30 tours (~17 s), l'arrêt de l'allocation (8 s sur rise chargé, 26/11) tombait après la fin.
      code: `for (let i = reprise?.i ?? 0; i < ${TOURS}; i++) { await outil("hub.mon_compte"); sauver({ i: i + 1 }); await pause(500); } return "fini";`,
      ...(reprise ? { reprise } : {}),
    });
    try { return JSON.parse(r.texte); } catch { return { texte: r.texte }; }
  };

  const avant = allocProgramme();
  if (!avant) throw new NonAbouti('allocation programme introuvable');
  // Jamais pendant un déploiement du Hub : deux remplacements à la fois ne mesurent rien.
  const deploiement = nomad('job', 'deployments', 'hub').split('\n')[1]?.trim().split(/\s+/)[3];
  if (deploiement !== 'successful') throw new NonAbouti(`déploiement du Hub en cours (${deploiement ?? 'illisible'}) : le moteur ne se remplace pas maintenant`);
  // Fenêtre (parente, 26/11) : jamais pendant un programme client. La trace du Hub (début et fin de chaque programme) le dit.
  const fenetre = await adminOk<{ en_cours: { qui: string }[]; aucun_client_en_cours: boolean; dernier_client: string | null }>('GET', `programmes?depuis=${new Date(Date.now() - 3600_000).toISOString()}`);
  if (!fenetre.aucun_client_en_cours) throw new NonAbouti(`un programme client tourne (${fenetre.en_cours.filter((p) => p.qui === 'client').length}) : le moteur ne se remplace pas maintenant`);
  const sante: number[] = [];
  let fini = false;
  const sonde = (async () => {
    while (!fini) {
      sante.push(await fetch(`${HUB_URL}/api/health`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0));
      await dormir(1_000);
    }
  })();

  const debut = Date.now();
  const vol = lancer();
  await dormir(6_000);
  if (process.env.SSO_SABOTAGE !== 'moteur-remplace') nomad('alloc', 'stop', '-detach', avant);
  const coupe = await vol;
  const rendu = Date.now() - debut;
  expect(coupe, `un état, jamais un silence (rendu à ${rendu} ms, ${coupe.appels?.faits ?? '?'} appels)`).toMatchObject({ etat: 'erreur', raison: 'moteur_arrete' });
  expect(rendu, 'rendu dès la coupure, pas à l\'échéance').toBeLessThan(40_000);
  expect(coupe.reprise?.i, 'reprise rendue').toBeGreaterThan(3);

  const raisons: string[] = [];
  let suite: any;
  const arret = Date.now();
  do {
    suite = await lancer(coupe.reprise);
    if (suite.etat !== 'termine') raisons.push(suite.raison ?? suite.etat ?? suite.texte);
    if (suite.etat !== 'termine') await dormir(2_000);
  } while (suite.etat !== 'termine' && Date.now() - arret < 180_000);
  fini = true;
  await sonde;
  expect(suite, `après ${raisons.join(', ')}`).toMatchObject({ etat: 'termine', resultat: 'fini' });
  expect(suite.appels.faits, 'reprend où il en était, ne refait pas').toBe(TOURS - coupe.reprise.i);
  expect(allocProgramme(), 'une autre allocation').not.toBe(avant);
  expect(Date.now() - arret, 'coupure du moteur sous 2 min (parente, 26/11)').toBeLessThan(120_000);
  expect(sante.filter((s) => s !== 200), `${sante.length} sondes de /api/health`).toEqual([]);
  return `fenêtre : aucun programme client en cours (dernier client ${fenetre.dernier_client ?? 'aucun sur 1 h'}) ; coupé à ${rendu} ms avec reprise i=${coupe.reprise.i} ; moteur revenu ${Math.round((Date.now() - arret) / 1000)} s après (${raisons.length} refus : ${[...new Set(raisons)].join(', ') || 'aucun'}) ; /api/health 200 sur ${sante.length} sondes`;
}, { timeout: 420_000 });
