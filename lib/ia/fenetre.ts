/**
 * La fenêtre de l'assistant (/ia/chat) s'ouvre-t-elle, et pour quel espace ? Décidé côté serveur, avant tout
 * affichage (docs/MON-IA.md). Aucune valeur par défaut ; refus visibles : le tenant demandé n'est pas un espace de
 * l'utilisateur connecté, ou l'app n'a pas de fenêtre au Hub (le CRM a son chat natif depuis le 23/11).
 */
import type { Preuve } from '@/lib/federation/obligation';

import { estAppFenetre } from './branchements';
import { espaceDe, type Espace } from './contexte';

export type Refus = 'espace_etranger' | 'chat_natif';
export type Fenetre = { ok: true; espace: Espace } | { ok: false; refus: Refus };

export const MESSAGES_REFUS: Record<Refus, string> = {
  espace_etranger: "Cet espace n'est pas l'un des vôtres : l'assistant ne s'ouvre pas ici.",
  chat_natif: "L'assistant du CRM est son chat natif : ouvrez « Nouveau chat IA » dans le CRM.",
};

export async function autoriserFenetre(
  p: { app: string; tenant?: string | null; hubUserId: string; preuve: Preuve },
  deps: { espaceDe?: typeof espaceDe } = {},
): Promise<Fenetre> {
  if (!estAppFenetre(p.app)) return { ok: false, refus: 'chat_natif' };
  const espace = p.tenant ? await (deps.espaceDe ?? espaceDe)(p.hubUserId, p.tenant, p.preuve, { app: p.app, workspaceId: null }) : null;
  return espace ? { ok: true, espace } : { ok: false, refus: 'espace_etranger' };
}
