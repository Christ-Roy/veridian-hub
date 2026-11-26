/**
 * La fenêtre de l'assistant (/ia/chat) s'ouvre-t-elle, et pour quel espace ? Décidé côté serveur, avant tout
 * affichage (docs/MON-IA.md). Aucune valeur par défaut ; refus visibles : le tenant demandé n'est pas un espace de
 * l'utilisateur connecté, l'app n'a pas de fenêtre au Hub (le CRM a son chat natif depuis le 23/11), ou aucun moteur ne peut répondre.
 * Sans moteur (ni clé ni abonnement), la fenêtre ne s'affiche pas : elle répondrait 409 à chaque question et renverrait vers un écran
 * qui ne propose que le connecteur (règle de Robert du 25/11). Elle dit à la place que l'IA reliée travaille depuis son propre écran.
 */
import type { Preuve } from '@/lib/federation/obligation';

import { prisma } from '@/lib/prisma';

import { estAppFenetre, moteurActif } from './branchements';
import { espaceDe, type Espace } from './contexte';

export type Refus = 'espace_etranger' | 'chat_natif' | 'sans_moteur';
export type Fenetre = { ok: true; espace: Espace } | { ok: false; refus: Refus };

export const MESSAGES_REFUS: Record<Refus, string> = {
  espace_etranger: "Cet espace n'est pas l'un des vôtres : l'assistant ne s'ouvre pas ici.",
  chat_natif: "L'assistant du CRM est son chat natif : ouvrez « Nouveau chat IA » dans le CRM.",
  sans_moteur:
    "Votre IA travaille dans vos apps Veridian depuis son propre écran (Claude, ChatGPT, Mistral…) : reliez-la une fois, sans clé. Cette fenêtre intégrée, elle, ne répond qu'avec un moteur branché à votre compte.",
};
/** Où renvoyer pour chaque refus, s'il y a un geste à faire. */
export const LIEN_REFUS: Partial<Record<Refus, { href: string; texte: string }>> = {
  sans_moteur: { href: '/dashboard/ia', texte: 'Relier mon IA' },
};

export async function autoriserFenetre(
  p: { app: string; tenant?: string | null; hubUserId: string; preuve: Preuve },
  deps: { espaceDe?: typeof espaceDe; moteur?: (hubUserId: string) => Promise<string | null> } = {},
): Promise<Fenetre> {
  if (!estAppFenetre(p.app)) return { ok: false, refus: 'chat_natif' };
  const espace = p.tenant ? await (deps.espaceDe ?? espaceDe)(p.hubUserId, p.tenant, p.preuve, { app: p.app, workspaceId: null }) : null;
  if (!espace) return { ok: false, refus: 'espace_etranger' };
  const moteur = await (deps.moteur ?? ((u: string) => moteurActif(prisma, u)))(p.hubUserId);
  return moteur ? { ok: true, espace } : { ok: false, refus: 'sans_moteur' };
}
