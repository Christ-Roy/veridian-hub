/**
 * La fenêtre de l'assistant (/ia/chat) s'ouvre-t-elle ? Décidé côté serveur, avant d'afficher quoi que ce soit
 * (docs/MON-IA.md, menace 8). Deux refus visibles :
 *   1. l'espace demandé (tenant, ou workspace de l'app) n'est pas un espace de l'utilisateur connecté ;
 *   2. CRM : la page qui affiche la fenêtre (en-tête Referer, posé par le navigateur) n'est pas l'espace Twenty de
 *      ce workspace, vérifié auprès de son plugin. Sans Referer lisible : refus.
 */
import { espaceDe, type Espace } from './contexte';
import { origineDe, verifierEspaceCrm, type VerdictEspace } from './espace-crm';

export type Fenetre =
  | { ok: true; espace: Espace; origine: string | null }
  | { ok: false; refus: 'espace_etranger' | 'hote_absent' | Exclude<VerdictEspace, 'ok'> };

export const MESSAGES_REFUS: Record<Exclude<Fenetre, { ok: true }>['refus'], string> = {
  espace_etranger: "Cet espace n'est pas l'un des vôtres : l'assistant ne s'ouvre pas ici.",
  hote_absent: "L'assistant ne s'ouvre que dans votre espace CRM : la page qui l'affiche n'a pas pu être identifiée.",
  origine_invalide: "L'assistant ne s'ouvre que dans une app Veridian.",
  origine_etrangere: "Cette page n'est pas votre espace CRM : l'assistant ne s'ouvre pas ici.",
  non_abouti: "L'assistant n'a pas pu vérifier l'espace CRM qui l'affiche. Réessayez dans un instant.",
};

export async function autoriserFenetre(
  p: { app: string; tenant?: string | null; workspace?: string | null; referer?: string | null; hubUserId: string },
  deps: { espaceDe?: typeof espaceDe; verifierEspaceCrm?: typeof verifierEspaceCrm } = {},
): Promise<Fenetre> {
  const espace = await (deps.espaceDe ?? espaceDe)(p.hubUserId, p.tenant ?? null, { app: p.app, workspaceId: p.workspace ?? null });
  if (!espace) return { ok: false, refus: 'espace_etranger' };
  if (p.app !== 'crm') return { ok: true, espace, origine: null };
  if (!espace.workspaceId) return { ok: false, refus: 'espace_etranger' };
  const origine = origineDe(p.referer);
  if (!origine) return { ok: false, refus: 'hote_absent' };
  const verdict = await (deps.verifierEspaceCrm ?? verifierEspaceCrm)(origine, espace.workspaceId, p.hubUserId);
  return verdict === 'ok' ? { ok: true, espace, origine } : { ok: false, refus: verdict };
}
