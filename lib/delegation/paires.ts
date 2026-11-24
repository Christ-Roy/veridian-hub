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
  P('notifuse', 'crm', ['crm:tache.ecrire'], 'Mail vers CRM : une réponse humaine crée une fiche et une tâche', 'evenement'),
  P('crm', 'notifuse', ['notifuse:contacts.ecrire'], 'CRM vers Mail : ajouter des contacts à une liste, sans envoi'),
  P('crm', 'prospection', ['prospection:exclusion.ecrire'], 'CRM vers Prospection : gagné, on ne prospecte plus', 'evenement'),
];

/** Clé au registre MCP (mcp_apps), qui porte l'adresse de la cible. */
export const CLE_MCP: Record<AppPaire, string> = { crm: 'twenty', notifuse: 'notifuse', prospection: 'prospection' };

/**
 * L'adresse d'action d'une cible, donc l'`aud` de son jeton : le CRM sert ses actions sur son MCP, les autres sur leur route dédiée (un
 * jeton à `act` y est refusé sur /api/mcp). Même origine que le registre MCP, donc staging ou prod selon l'environnement.
 */
export const adresseAction = (cible: AppPaire, mcpUrl: string): string => (cible === 'crm' ? mcpUrl : new URL('/api/veridian/actions', mcpUrl).toString());

export const paire = (cle: string): Paire | undefined => PAIRES.find((p) => p.cle === cle);
export const paireEntre = (source: string, cible: string): Paire | undefined => PAIRES.find((p) => p.source === source && p.cible === cible);

/** `DELEGATION_CIBLES` : `crm` ouvre à tous ; `crm@test` n'ouvre qu'aux organisations d'un compte de test (preuve en prod sans client). */
export const cibleServie = (cible: AppPaire, env: NodeJS.ProcessEnv = process.env, test = false): boolean => {
  const l = (env.DELEGATION_CIBLES ?? '').split(',').map((x) => x.trim());
  return l.includes(cible) || (test && l.includes(`${cible}@test`));
};
/**
 * Une liaison qui peut servir : cible ouverte, et une ACTION. Un événement n'a pas d'utilisateur (son sujet est l'intégration, ADR-037
 * D1) : tant que son chemin n'existe pas, il ne s'allume pas et ne s'échange pas contre la poignée de quelqu'un.
 */
export const paireServie = (p: Paire, env: NodeJS.ProcessEnv = process.env, test = false): boolean => p.nature === 'action' && cibleServie(p.cible, env, test);
/**
 * Un événement se règle à part (`DELEGATION_EVENEMENTS`, vide par défaut) : `notifuse>crm` pour tous, `notifuse>crm@<tenant>` pour une seule
 * organisation, `notifuse>crm@test` pour celles marquées de test. Ouvert ne veut pas dire allumé : le clic du propriétaire reste dû.
 */
export const evenementOuvert = (cle: string, tenantId: string, env: NodeJS.ProcessEnv = process.env, test = false): boolean => {
  const l = (env.DELEGATION_EVENEMENTS ?? '').split(',').map((x) => x.trim());
  return l.includes(cle) || l.includes(`${cle}@${tenantId}`) || (test && l.includes(`${cle}@test`));
};
/** Ce qu'une organisation peut régler : une action servie, ou un événement ouvert pour elle. L'ÉCHANGE d'un jeton, lui, reste aux actions. */
export const paireReglable = (p: Paire, tenantId: string, env: NodeJS.ProcessEnv = process.env, test = false): boolean => paireServie(p, env, test) || (p.nature === 'evenement' && evenementOuvert(p.cle, tenantId, env, test));
export const pairesServies = (env: NodeJS.ProcessEnv = process.env, test = false): Paire[] => PAIRES.filter((p) => paireServie(p, env, test));

/** Ce que le propriétaire a accepté : élargir une portée change l'empreinte, donc redemande son clic. */
export const empreintePortees = (p: Paire): string => createHash('sha256').update([...p.portees].sort().join(' ')).digest('hex').slice(0, 16);

/** Les portées demandées, si elles tiennent toutes dans la paire ; `null` sinon. Jamais une portée complète. */
export function porteesAccordees(p: Paire, demande: string | undefined): string | null {
  const l = (demande ?? '').split(/\s+/).filter(Boolean);
  return l.length > 0 && new Set(l).size === l.length && l.every((x) => p.portees.includes(x)) ? l.join(' ') : null;
}
