/**
 * L'état d'une liaison, en UN endroit (Robert, 25/11 : les apps d'un même Hub sont connectées nativement). C'est une règle de LECTURE : rien n'est écrit chez
 * personne. Un geste (quelqu'un clique) est actif par défaut dans toute organisation où les deux apps sont ouvertes ; un événement (il écrit seul), dans les
 * organisations NEUVES seulement, et se propose aux autres. Toute coupure posée tient. « Par défaut » n'est jamais dit consenti.
 */
import type { PrismaClient } from '@prisma/client';

import { empreintePortees, type AppPaire, type Paire } from './paires';

/** Le jour de la règle : une organisation née après reçoit aussi les événements. */
export const NEUVE_DEPUIS = new Date('2026-11-26T00:00:00Z');
/** Ce que « par défaut » ouvre, figé : élargir une portée la referme par défaut, tant que personne n'a décidé de l'élargir ici aussi. */
const PAR_DEFAUT: Record<string, string> = {
  'prospection>crm': 'crm:societe.ecrire crm:tache.ecrire',
  'prospection>notifuse': 'notifuse:contacts.ecrire',
  'notifuse>crm': 'crm:tache.ecrire',
};

export type LignePaire = { etat: string; consentiLe: Date | null; portees: string | null } | null | undefined;
export type Contexte = { ouvertes: ReadonlySet<AppPaire>; neuve: boolean };

export function etatDe(p: Paire, l: LignePaire, c: Contexte, servie: boolean): { etat: 'allumee' | 'eteinte' | 'indisponible'; consentie: boolean; parDefaut: boolean } {
  const consentie = Boolean(l?.consentiLe && l.portees === empreintePortees(p));
  if (!servie) return { etat: 'indisponible', consentie, parDefaut: false };
  // `defaut` : la ligne ne garde que le dernier passage, personne n'a rien réglé.
  if (l && l.etat !== 'defaut') return { etat: l.etat === 'allumee' && consentie ? 'allumee' : 'eteinte', consentie, parDefaut: false };
  const connue = PAR_DEFAUT[p.cle] === [...p.portees].sort().join(' ');
  const parDefaut = connue && c.ouvertes.has(p.source) && c.ouvertes.has(p.cible) && (p.nature === 'action' || c.neuve);
  return { etat: parDefaut ? 'allumee' : 'eteinte', consentie, parDefaut };
}

/** Les apps ouvertes d'une organisation : son espace y existe, ou elle l'a cochée. Organisation inconnue : aucune. */
export async function contexteDe(db: Pick<PrismaClient, 'tenant' | 'organisation'>, tenantId: string): Promise<Contexte> {
  const [t, o] = await Promise.all([
    db.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { prospectionProvisionedAt: true, notifuseWorkspaceSlug: true, metadata: true, createdAt: true } }),
    db.organisation.findUnique({ where: { tenantId }, select: { modules: true } }),
  ]);
  if (!t) return { ouvertes: new Set(), neuve: false };
  const crm = ((t.metadata ?? {}) as { crm?: { workspace_id?: unknown } }).crm?.workspace_id;
  const a = { prospection: Boolean(t.prospectionProvisionedAt), notifuse: Boolean(t.notifuseWorkspaceSlug), crm: typeof crm === 'string' && crm !== '' };
  const ouvertes = (Object.keys(a) as AppPaire[]).filter((x) => a[x] || o?.modules.includes(x));
  return { ouvertes: new Set(ouvertes), neuve: t.createdAt >= NEUVE_DEPUIS };
}

/** Pour qui décide à chaque usage : la liaison, maintenant, dans cette organisation. */
export async function liaisonActive(db: Pick<PrismaClient, 'tenant' | 'organisation' | 'integrationPaire'>, p: Paire, tenantId: string): Promise<boolean> {
  const l = await db.integrationPaire.findUnique({ where: { tenantId_paire: { tenantId, paire: p.cle } } });
  return etatDe(p, l, await contexteDe(db, tenantId), true).etat === 'allumee';
}

/** Le dernier passage d'une liaison par défaut se garde sans rien régler. */
export async function noterPassage(db: Pick<PrismaClient, 'integrationPaire'>, p: Paire, tenantId: string, le = new Date()): Promise<void> {
  const passe = { dernierPassage: le, derniereErreur: null };
  await db.integrationPaire.upsert({ where: { tenantId_paire: { tenantId, paire: p.cle } }, create: { tenantId, paire: p.cle, etat: 'defaut', changePar: 'hub defaut', ...passe }, update: passe });
}
