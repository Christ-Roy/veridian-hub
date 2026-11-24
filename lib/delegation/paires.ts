/**
 * Registre FERMÉ des paires d'apps qui peuvent agir l'une dans l'autre (VER-245 b.2, ADR-037). Aucune action destructive : créer et
 * compléter, jamais supprimer. Une cible n'est servie que si elle a dit « garde servie » : une app qui ignore `act` prendrait le jeton
 * pour un jeton complet. Fermé par défaut (`DELEGATION_CIBLES`).
 */
import { createHash } from 'node:crypto';

export type AppPaire = 'prospection' | 'notifuse' | 'crm';
export type Paire = { cle: string; source: AppPaire; cible: AppPaire; portees: readonly string[]; libelle: string; nature: 'action' | 'evenement' };

const P = (source: AppPaire, cible: AppPaire, portees: readonly string[], libelle: string, nature: Paire['nature'] = 'action'): Paire => ({ cle: `${source}>${cible}`, source, cible, portees, libelle, nature });

export const PAIRES: readonly Paire[] = [
  P('prospection', 'crm', ['crm:societe.ecrire', 'crm:tache.ecrire'], 'Prospection vers CRM : envoyer une fiche au CRM'),
  P('prospection', 'notifuse', ['notifuse:contacts.ecrire'], 'Prospection vers Mail : verser des contacts dans une liste, sans envoi'),
  P('notifuse', 'crm', ['crm:personne.ecrire', 'crm:tache.ecrire'], 'Mail vers CRM : une réponse humaine crée une fiche et une tâche', 'evenement'),
  P('crm', 'notifuse', ['notifuse:contacts.ecrire'], 'CRM vers Mail : ajouter des contacts à une liste, sans envoi'),
  P('crm', 'prospection', ['prospection:exclusion.ecrire'], 'CRM vers Prospection : gagné, on ne prospecte plus', 'evenement'),
];

/** Clé au registre MCP (mcp_apps), qui porte l'adresse de la cible. */
export const CLE_MCP: Record<AppPaire, string> = { crm: 'twenty', notifuse: 'notifuse', prospection: 'prospection' };

export const paire = (cle: string): Paire | undefined => PAIRES.find((p) => p.cle === cle);
export const paireEntre = (source: string, cible: string): Paire | undefined => PAIRES.find((p) => p.source === source && p.cible === cible);

export const cibleServie = (cible: AppPaire, env: NodeJS.ProcessEnv = process.env): boolean => (env.DELEGATION_CIBLES ?? '').split(',').map((x) => x.trim()).includes(cible);
export const pairesServies = (env: NodeJS.ProcessEnv = process.env): Paire[] => PAIRES.filter((p) => cibleServie(p.cible, env));

/** Ce que le propriétaire a accepté : élargir une portée change l'empreinte, donc redemande son clic. */
export const empreintePortees = (p: Paire): string => createHash('sha256').update([...p.portees].sort().join(' ')).digest('hex').slice(0, 16);

/** Les portées demandées, si elles tiennent toutes dans la paire ; `null` sinon. Jamais une portée complète. */
export function porteesAccordees(p: Paire, demande: string | undefined): string | null {
  const l = (demande ?? '').split(/\s+/).filter(Boolean);
  return l.length > 0 && new Set(l).size === l.length && l.every((x) => p.portees.includes(x)) ? l.join(' ') : null;
}
