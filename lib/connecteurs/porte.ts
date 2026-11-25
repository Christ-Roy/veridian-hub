/** Les services extérieurs d'une personne, vus par la porte MCP comme ses apps (VER-244) : leurs outils, appelés avec SON jeton, jamais le nôtre. */
import type { PrismaClient } from '@prisma/client';

import { fetchGarde } from '@/lib/federation/sortie';
import { getURL } from '@/utils/helpers';
import { AppInjoignable, SessionApp } from '@/lib/mcp/client-app';

import { jetonDe, type EtatConnexion } from './coffre';
import { CHEMIN_RETOUR_CONNECTEUR, type Deps } from './oauth';
import { connecteur, CONNECTEURS, connecteursOuverts } from './registre';

type Db = Pick<PrismaClient, 'connecteurClient' | 'connexionExterne' | 'auditLog'>;
export type ServiceExterne = { appKey: string; label: string; mcpUrl: string; externe: true };
const MAX_OCTETS = 2_000_000;

export const retourConnecteur = (): string => getURL(CHEMIN_RETOUR_CONNECTEUR);

export async function servicesDe(db: Pick<PrismaClient, 'connexionExterne'>, hubUserId: string): Promise<ServiceExterne[]> {
  if (!connecteursOuverts()) return [];
  // Absente d'une base d'épreuve partielle : aucune connexion.
  const l = (await db.connexionExterne?.findMany({ where: { hubUserId, etat: 'active' satisfies EtatConnexion['etat'] }, select: { connecteur: true } })) ?? [];
  return CONNECTEURS.filter((c) => l.some((x) => x.connecteur === c.cle)).map((c) => ({ appKey: c.cle, label: c.nom, mcpUrl: c.mcpUrl, externe: true as const }));
}

/** Ouvre une session chez le service. Son refus du jeton vaut UN renouvellement, jamais une boucle. */
export async function sessionExterne(db: Db, hubUserId: string, cle: string, d: Deps = {}): Promise<SessionApp> {
  const c = connecteursOuverts() ? connecteur(cle) : null;
  if (!c) throw new AppInjoignable('service inconnu');
  const dire = `${c.nom} est à rebrancher : Connexions, dans votre espace Veridian`;
  const ouvrir = async (force: boolean): Promise<SessionApp> => {
    const jeton = await jetonDe(db, hubUserId, c, retourConnecteur(), { ...d, force }).catch(() => { throw new AppInjoignable(`${c.nom} ne répond pas`); });
    if (!jeton) throw new AppInjoignable(dire);
    const s = new SessionApp(c.mcpUrl, jeton, (d.fetchImpl ?? fetchGarde) as never, { maxOctets: MAX_OCTETS });
    await s.ouvrir();
    return s;
  };
  try {
    return await ouvrir(false);
  } catch (err) {
    if (!(err instanceof AppInjoignable) || !/HTTP 40[13]/.test(err.message)) throw err;
    return ouvrir(true);
  }
}
