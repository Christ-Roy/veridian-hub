/**
 * Les programmes du mode programme (porte MCP), lus dans le journal : qui en a lancé, lesquels tournent encore.
 * Le Hub écrit `mcp.programme.debut` au lancement et `mcp.programme` à la fin (même identifiant `programme`). Un début sans fin
 * plus jeune que l'échéance du moteur est EN COURS ; plus vieux, il a été PERDU (moteur ou Hub arrêté pendant qu'il tournait).
 * Sert d'abord à choisir une fenêtre sans programme client avant de remplacer le moteur (cas 20, parente, 26/11).
 * Aucune adresse ni aucun code rendu : un compte d'épreuve se reconnaît à son adresse (`estCompteDeTest`), le reste est « client ».
 */
import { estCompteDeTest } from '@/lib/email/compte-de-test';

import { DELAI_MS } from './programme';

export const ACTION_DEBUT = 'mcp.programme.debut';
const ACTION_FIN = 'mcp.programme';
/** Au-delà, un début sans fin n'est plus en cours : le moteur coupe à DELAI_MS, la marge couvre l'écriture de la fin. */
export const EN_COURS_MAX_MS = DELAI_MS + 2 * 60_000;

type Ligne = { action: string; targetId: string | null; payload: unknown; createdAt: Date };
export type DbProgrammes = {
  auditLog: { findMany: (a: unknown) => Promise<Ligne[]> };
  user: { findMany: (a: unknown) => Promise<{ supabaseUserId: string | null; email: string | null }[]> };
};

export type ProgrammeLu = { programme: string; qui: 'essai' | 'client'; debut: string | null; fin: string | null; etat: string | null; ms: number | null };
export type LectureProgrammes = {
  depuis: string;
  en_cours: ProgrammeLu[];
  perdus: ProgrammeLu[];
  termines: { essai: number; client: number };
  dernier_client: string | null;
  /** Vrai quand aucun programme client ne tourne : la fenêtre se lit avec `dernier_client`. */
  aucun_client_en_cours: boolean;
};

const champ = (p: unknown, k: string): unknown => (p && typeof p === 'object' ? (p as Record<string, unknown>)[k] : undefined);

export async function lireProgrammes(db: DbProgrammes, depuis: Date, maintenant = Date.now()): Promise<LectureProgrammes> {
  const lignes = await db.auditLog.findMany({
    where: { action: { in: [ACTION_DEBUT, ACTION_FIN] }, createdAt: { gte: depuis } },
    orderBy: { createdAt: 'asc' },
    select: { action: true, targetId: true, payload: true, createdAt: true },
    take: 5_000,
  });
  const ids = Array.from(new Set(lignes.map((l) => l.targetId).filter((x): x is string => !!x)));
  const comptes = ids.length ? await db.user.findMany({ where: { supabaseUserId: { in: ids } }, select: { supabaseUserId: true, email: true } }) : [];
  // Un compte introuvable (supprimé depuis) est compté client : on ne suppose jamais qu'un inconnu est une épreuve.
  const essai = new Set(comptes.filter((c) => c.email && estCompteDeTest(c.email)).map((c) => c.supabaseUserId));

  const parId = new Map<string, ProgrammeLu>();
  for (const l of lignes) {
    const id = champ(l.payload, 'programme');
    if (typeof id !== 'string') continue;
    const p = parId.get(id) ?? { programme: id, qui: l.targetId && essai.has(l.targetId) ? 'essai' : 'client', debut: null, fin: null, etat: null, ms: null };
    if (l.action === ACTION_DEBUT) p.debut = l.createdAt.toISOString();
    else {
      p.fin = l.createdAt.toISOString();
      p.etat = String(champ(l.payload, 'etat') ?? '') || null;
      p.ms = typeof champ(l.payload, 'ms') === 'number' ? (champ(l.payload, 'ms') as number) : null;
    }
    parId.set(id, p);
  }
  const tous = Array.from(parId.values());
  const ouverts = tous.filter((p) => p.debut && !p.fin);
  const en_cours = ouverts.filter((p) => maintenant - Date.parse(p.debut!) < EN_COURS_MAX_MS);
  const perdus = ouverts.filter((p) => maintenant - Date.parse(p.debut!) >= EN_COURS_MAX_MS);
  const clients = tous.filter((p) => p.qui === 'client').map((p) => p.fin ?? p.debut!).sort();
  return {
    depuis: depuis.toISOString(),
    en_cours,
    perdus,
    termines: { essai: tous.filter((p) => p.fin && p.qui === 'essai').length, client: tous.filter((p) => p.fin && p.qui === 'client').length },
    dernier_client: clients.at(-1) ?? null,
    aucun_client_en_cours: !en_cours.some((p) => p.qui === 'client'),
  };
}
