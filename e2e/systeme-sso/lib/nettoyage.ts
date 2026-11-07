/**
 * Retrait des comptes de test, app par app : Rybbit, workspace Notifuse, puis Hub (qui pousse la
 * suppression à Prospection et Notifuse). Appelé en fin de scénario, par `99-nettoyage` et par le
 * teardown : un échec, même dans la batterie, ne laisse rien. Un compte non retiré reste au registre.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { NonAbouti } from './etat';
import { lookup, reconcile, rybbitCompte, supprimerNotifuse, supprimerTenantHub } from './hub-admin';
import { comptesNotes, comptesRybbitNotes, oublierCompte, oublierRybbit } from './parcours';
import { PREFIXE_COMPTE } from './cibles';
import { RUN_DIR } from './versions';

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** L'opérateur Rybbit se connecte à chaque retrait et prend vite un 429 : on patiente. */
async function retirerDeRybbit(email: string): Promise<void> {
  for (const pause of [0, 30_000, 90_000]) {
    await attendre(pause);
    try {
      rybbitCompte('supprimer', email);
      oublierRybbit(email);
      return;
    } catch (e) {
      if (pause === 90_000 || !/429/.test((e as Error).message)) throw e;
    }
  }
}

export async function nettoyerCompte(email: string): Promise<void> {
  if (comptesRybbitNotes().includes(email)) await retirerDeRybbit(email);
  const u = await lookup(email);
  if (u.status !== 404) {
    for (const t of (u.json?.tenants ?? []) as { id: string; notifuseWorkspaceSlug?: string }[]) {
      if (t.notifuseWorkspaceSlug) await supprimerNotifuse(t.id);
    }
    await supprimerTenantHub(email);
    if ((await lookup(email)).status !== 404) throw new Error(`${email} encore présent au Hub après suppression`);
  }
  oublierCompte(email);
}

/** Retire tout le registre, compte par compte : un échec n'empêche pas les suivants. */
export async function nettoyerTout(): Promise<{ retires: number; echecs: string[] }> {
  const emails = Array.from(new Set([...comptesNotes(), ...comptesRybbitNotes()]));
  const echecs: string[] = [];
  for (const email of emails) {
    await nettoyerCompte(email).catch((e) => echecs.push(`${email} : ${(e as Error).message.slice(0, 140)}`));
  }
  return { retires: emails.length - echecs.length, echecs };
}

/** Ce que la prod garde de cette batterie, mesuré par `hub reconcile`. Pas de mesure = pas de verdict. */
export async function mesurerRestes(): Promise<string[]> {
  const r = (await reconcile()) as {
    testResidue?: { hub: string[]; apps: Record<string, string[]> };
  };
  if (!r.testResidue) throw new NonAbouti('reconcile ne mesure pas encore les restes de test (Hub trop ancien)');
  const tous = [
    ...r.testResidue.hub.map((e) => `hub:${e}`),
    ...Object.entries(r.testResidue.apps).flatMap(([app, l]) => l.map((e) => `${app}:${e}`)),
  ];
  return tous.filter((x) => x.includes(`:${PREFIXE_COMPTE}`));
}

/** Verdict relu par le lanceur de la batterie, pour qu'un reste fasse échouer toute la commande. */
export function ecrireVerdictRestes(v: { restes?: string[]; echecs?: string[]; nonAbouti?: string }) {
  writeFileSync(path.join(RUN_DIR, 'restes.json'), JSON.stringify(v));
}
