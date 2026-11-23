/**
 * La fenêtre de l'assistant (/ia/chat) s'ouvre-t-elle, et pour quel espace ? Décidé côté serveur, avant tout
 * affichage (docs/MON-IA.md, menace 8). Aucune valeur par défaut ; refus visibles :
 *   - Academy et autres : le tenant demandé n'est pas un espace de l'utilisateur connecté ;
 *   - CRM : l'espace se trouve par l'origine de la page hôte (Referer, posé par le navigateur), demandée au plugin
 *     de cette origine. Refus si le Referer manque, si l'origine n'est pas un espace du CRM, si le plugin ne répond
 *     pas, si le workspace servi n'est pas un espace de l'utilisateur, ou s'il diffère du `workspace=` fourni.
 */
import { espaceDe, type Espace } from './contexte';
import { origineDe, workspaceDeLOrigine } from './espace-crm';

export type Refus = 'espace_etranger' | 'hote_absent' | 'origine_invalide' | 'origine_etrangere' | 'non_abouti';
export type Fenetre = { ok: true; espace: Espace; origine: string | null } | { ok: false; refus: Refus };

export const MESSAGES_REFUS: Record<Refus, string> = {
  espace_etranger: "Cet espace n'est pas l'un des vôtres : l'assistant ne s'ouvre pas ici.",
  hote_absent: "L'assistant ne s'ouvre que dans votre espace CRM : la page qui l'affiche n'a pas pu être identifiée.",
  origine_invalide: "L'assistant ne s'ouvre que dans une app Veridian.",
  origine_etrangere: "Cette page n'est pas votre espace CRM : l'assistant ne s'ouvre pas ici.",
  non_abouti: "L'assistant n'a pas pu vérifier l'espace CRM qui l'affiche. Réessayez dans un instant.",
};

export async function autoriserFenetre(
  p: { app: string; tenant?: string | null; workspace?: string | null; referer?: string | null; hubUserId: string },
  deps: { espaceDe?: typeof espaceDe; workspaceDeLOrigine?: typeof workspaceDeLOrigine } = {},
): Promise<Fenetre> {
  const trouver = deps.espaceDe ?? espaceDe;
  if (p.app !== 'crm') {
    const espace = p.tenant ? await trouver(p.hubUserId, p.tenant, { app: p.app, workspaceId: null }) : null;
    return espace ? { ok: true, espace, origine: null } : { ok: false, refus: 'espace_etranger' };
  }
  const origine = origineDe(p.referer);
  if (!origine) return { ok: false, refus: 'hote_absent' };
  const w = await (deps.workspaceDeLOrigine ?? workspaceDeLOrigine)(origine, p.hubUserId);
  if (!w.ok) return { ok: false, refus: w.verdict };
  if (p.workspace && p.workspace !== w.workspaceId) return { ok: false, refus: 'origine_etrangere' };
  const espace = await trouver(p.hubUserId, null, { app: 'crm', workspaceId: w.workspaceId });
  if (!espace) return { ok: false, refus: 'espace_etranger' };
  return { ok: true, espace, origine };
}
