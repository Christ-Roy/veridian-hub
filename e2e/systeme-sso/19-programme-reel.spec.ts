/**
 * Le parcours pour lequel le mode programme existe (VER-241) : un segment de Prospection entre dans une liste de Mail, par la
 * porte, en un programme repris jusqu'au bout, sans geste ni fichier. Compte et espaces de test, retirés par la batterie ;
 * aucune séquence, aucun envoi (ni reservoir_activate, ni allow_triggers).
 * Volume : 240 contacts par pages de 30 ; `SSO_PROGRAMME_LIGNES=4000 SSO_PROGRAMME_PAGE=1000` pour plusieurs milliers (quota
 * de Prospection : 5 000 par jour et espace ; pages de plus de 30 : Prospection doit lire X-Veridian-MCP-Appel).
 * Épreuve : `SSO_SABOTAGE=programme-reel` n'importe que la moitié de chaque page : le cas doit échouer.
 */
import { expect } from '@playwright/test';

import { HUB_URL } from './lib/cibles';
import { cas, NonAbouti } from './lib/etat';
import { planHub } from './lib/hub-admin';
import { obtenirJetonMcp, outil } from './lib/mcp';
import { creerCompteProuve } from './lib/parcours';

const LIGNES = Number(process.env.SSO_PROGRAMME_LIGNES ?? 240);
const PAGE = Number(process.env.SSO_PROGRAMME_PAGE ?? 30);

const CODE = (segment: string, liste: string, lignes = LIGNES) => `
const e = reprise ?? { c: null, lues: 0, retires: 0, importes: 0, crees: 0, presents: 0, ecartes: {}, pages: 0 };
while (e.lues < ${lignes}) {
  const p = await outil("prospection.extraire_segment", { segment_id: "${segment}", limite: Math.min(${PAGE}, ${lignes} - e.lues), ...(e.c ? { curseur: e.c } : {}) });
  if (typeof p === "string") throw new Error("page illisible (" + p.length + " caractères) : " + p.slice(-120));
  const lot = p.lignes${process.env.SSO_SABOTAGE === 'programme-reel' ? '.filter((_, i) => i % 2)' : ''};
  const r = await outil("notifuse.contacts_import", {
    contacts: lot.map((l) => ({ email: l.email, siren: l.siren, phone: l.telephone || undefined, domaine: l.domaine || undefined, raison_sociale: l.raison_sociale, ville: l.commune, naf: l.naf })),
    list_ids: ["${liste}"],
  });
  e.lues += p.lignes.length + p.retires.length; e.retires += p.retires.length; e.importes += lot.length; e.crees += r.created; e.presents += (r.existing ?? 0) + (r.updated ?? 0); e.pages += 1; e.c = p.curseur_suivant;
  for (const k in r.skipped ?? {}) e.ecartes[k] = (e.ecartes[k] ?? 0) + r.skipped[k];
  sauver(e);
  if (!e.c) break;
}
return e;`;

cas(null, 'porte MCP : un programme verse un segment de Prospection dans une liste de Mail', async ({ browser }) => {
  if (/staging/.test(HUB_URL)) throw new NonAbouti('les apps de staging n\'ont ni les entreprises ni l\'import : se joue en prod');
  const E = await creerCompteProuve(browser, 'progreel');
  if (!E.tenantId) throw new NonAbouti('compte de test sans tenant');
  await planHub(E.tenantId, 'prospection', 'pro');
  const jeton = await obtenirJetonMcp(browser, E, 'TEST PROGRAMME REEL');
  const executer = async (nom: string, args: Record<string, unknown> = {}) => {
    const r = await outil(jeton, 'executer_outil', { nom, arguments: args });
    expect(r.isError, `${nom} : ${r.texte.slice(0, 300)}`).toBe(false);
    return JSON.parse(r.texte);
  };
  const programme = async (args: Record<string, unknown>) => {
    const r = await outil(jeton, 'executer_programme', args);
    try { return JSON.parse(r.texte); } catch { throw new NonAbouti(`executer_programme : ${r.texte.slice(0, 200)}`); }
  };

  const seg = await executer('prospection.creer_segment', { nom: 'TEST programme', filtre: { conditions: [{ champ: 'departement', op: 'dans', valeur: ['69'] }] } });
  expect(seg.total, 'entreprises du segment').toBeGreaterThan(LIGNES);
  const liste = 'testprogramme';
  await executer('notifuse.lists_create', { id: liste, name: 'TEST programme' });
  const compter = async () => Number((JSON.stringify(await executer('notifuse.contacts_count')).match(/\d+/) ?? ['-1'])[0]);
  const avant = await compter();

  // Sans l'avoir nommé, l'import (destructif) est refusé, et rien n'est écrit.
  const refus = await programme({ code: CODE(seg.id, liste) });
  expect(refus.etat, 'import non autorisé').toBe('erreur');
  expect(JSON.stringify(refus)).toContain('autoriser');
  expect(await compter(), 'rien écrit sans autorisation').toBe(avant);

  let reprise: unknown;
  let tours = 0;
  let fin: any;
  const durees: number[] = [];
  do {
    fin = await programme({ code: CODE(seg.id, liste), autoriser: ['notifuse.contacts_import'], ...(reprise ? { reprise } : {}) });
    tours += 1;
    durees.push(fin.duree_ms);
    if (fin.etat === 'interrompu' && fin.reprise) reprise = fin.reprise;
  } while (fin.etat === 'interrompu' && tours < 12);
  expect(fin.etat, JSON.stringify(fin).slice(0, 400)).toBe('termine');
  const e = fin.resultat;
  expect(e.lues, 'lignes lues').toBeGreaterThanOrEqual(LIGNES);
  const apres = await compter();
  expect(apres - avant, 'contacts réellement dans l\'espace').toBe(e.crees);
  const ecartes = Object.values(e.ecartes as Record<string, number>).reduce((a, b) => a + b, 0);
  expect(e.crees + e.presents + ecartes, `chaque ligne lue est créée, déjà présente, ou écartée avec un motif : ${JSON.stringify(e).slice(0, 300)}`).toBe(e.lues - e.retires);

  // Rejouer depuis le début ne crée rien de plus : même liste figée, import dédoublonné.
  const rejeu = await programme({ code: CODE(seg.id, liste, Math.min(LIGNES, PAGE)), autoriser: ['notifuse.contacts_import'] });
  expect(rejeu.etat, JSON.stringify(rejeu).slice(0, 300)).toBe('termine');
  expect(rejeu.resultat.crees, 'rejeu').toBe(0);
  expect(await compter(), 'rejeu').toBe(apres);
  return `${e.lues} lues, ${e.crees} contacts créés, ${e.presents} déjà présents, écartés ${JSON.stringify(e.ecartes)}, ${e.retires} retirées par Prospection, ${e.pages} pages, ${tours} programme(s) de ${durees.join(', ')} ms`;
}, { timeout: 1_200_000 });
