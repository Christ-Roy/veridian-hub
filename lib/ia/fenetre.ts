/**
 * La fenêtre de l'assistant (/ia/chat) s'ouvre-t-elle, et pour quel espace ? Décidé côté serveur, avant tout
 * affichage (docs/MON-IA.md). Aucune valeur par défaut ; refus visibles : le tenant demandé n'est pas un espace de
 * l'utilisateur connecté, l'app n'a pas de fenêtre au Hub (le CRM a son chat natif depuis le 23/11), l'assistant est éteint pour cette app,
 * ou aucun moteur ne peut répondre (règle commune : lib/ia/etat-fenetre.ts, lue aussi par les apps).
 * Sans moteur (ni clé ni abonnement), la fenêtre ne s'affiche pas : elle répondrait 409 à chaque question et renverrait vers un écran
 * qui ne propose que le connecteur (règle de Robert du 25/11). Elle dit à la place que l'IA reliée travaille depuis son propre écran.
 */
import type { Preuve } from '@/lib/federation/obligation';

import { prisma } from '@/lib/prisma';

import { estAppFenetre } from './branchements';
import { espaceDe, type Espace } from './contexte';
import { etatFenetre, type EtatFenetre } from './etat-fenetre';

export type Refus = 'espace_etranger' | 'chat_natif' | 'sans_moteur' | 'eteinte';
export type Fenetre = { ok: true; espace: Espace } | { ok: false; refus: Refus };

export const MESSAGES_REFUS: Record<Refus, string> = {
  espace_etranger: "Cet espace n'est pas l'un des vôtres : l'assistant ne s'ouvre pas ici.",
  chat_natif: "L'assistant du CRM est son chat natif : ouvrez « Nouveau chat IA » dans le CRM.",
  sans_moteur:
    "Votre IA travaille dans vos apps Veridian depuis son propre écran (Claude, ChatGPT, Mistral…) : reliez-la une fois, sans clé. Cette fenêtre intégrée, elle, ne répond qu'avec un moteur branché à votre compte.",
  eteinte: "Vous avez éteint l'assistant pour cette app. Rallumez-le dans votre espace Veridian, rubrique Assistants IA.",
};
/** Où renvoyer pour chaque refus, s'il y a un geste à faire. */
export const LIEN_REFUS: Partial<Record<Refus, { href: string; texte: string }>> = {
  sans_moteur: { href: '/dashboard/ia', texte: 'Relier mon IA' },
  eteinte: { href: '/dashboard/ia', texte: 'Rallumer' },
};

export async function autoriserFenetre(
  p: { app: string; tenant?: string | null; hubUserId: string; preuve: Preuve },
  deps: { espaceDe?: typeof espaceDe; etat?: (t: { hubUserId: string; app: string; tenantId: string }) => Promise<EtatFenetre> } = {},
): Promise<Fenetre> {
  if (!estAppFenetre(p.app)) return { ok: false, refus: 'chat_natif' };
  const espace = p.tenant ? await (deps.espaceDe ?? espaceDe)(p.hubUserId, p.tenant, p.preuve, { app: p.app, workspaceId: null }) : null;
  if (!espace) return { ok: false, refus: 'espace_etranger' };
  const etat = await (deps.etat ?? ((t) => etatFenetre(prisma, t)))({ hubUserId: p.hubUserId, app: p.app, tenantId: espace.id });
  return etat === 'prete' ? { ok: true, espace } : { ok: false, refus: etat };
}
