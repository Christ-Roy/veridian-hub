/**
 * La fenêtre de l'assistant peut-elle répondre ? Une seule règle, lue par la page `/ia/chat` et par les apps (`POST /api/ia/etat`,
 * CONTRAT-HUB §5.24.1) : une fenêtre qui refuserait chaque question ne s'affiche jamais (parente, 26/11). Même ordre que
 * `/api/ia/chat` : l'interrupteur de l'app pour cet espace, puis le moteur du compte, puis l'abonnement ouvert dans cet espace.
 * Un abonnement fermé dans l'espace vaut « sans moteur » ici : la fenêtre n'y répondrait pas.
 */
import type { PrismaClient } from '@prisma/client';

import { atelierOuvertPourTenant } from './atelier';
import { estActive, moteurActif } from './branchements';

/** Les apps qui insèrent la fenêtre du Hub et peuvent lire son état (le CRM a son chat natif). */
export const APPS_FENETRE = ['academy', 'notifuse', 'prospection', 'analytics'] as const;

export type EtatFenetre = 'prete' | 'sans_moteur' | 'eteinte';

type Db = Pick<PrismaClient, 'iaActivation' | 'iaBranchement' | 'tenant'>;

export async function etatFenetre(
  db: Db,
  t: { hubUserId: string; app: string; tenantId: string },
  deps: { atelierOuvert?: (db: Db, tenantId: string) => Promise<boolean> } = {},
): Promise<EtatFenetre> {
  if (!(await estActive(db as never, t))) return 'eteinte';
  const moteur = await moteurActif(db as never, t.hubUserId);
  if (!moteur) return 'sans_moteur';
  if (moteur === 'claude-code-abonnement' && !(await (deps.atelierOuvert ?? ((d, id) => atelierOuvertPourTenant(d as never, id)))(db, t.tenantId))) {
    return 'sans_moteur';
  }
  return 'prete';
}
