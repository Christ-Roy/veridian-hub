/** Les services extérieurs d'une personne, vus par la porte MCP comme ses apps (VER-244) : leurs outils relus, appelés avec SON jeton, jamais le nôtre. */
import type { PrismaClient } from '@prisma/client';

import { getURL } from '@/utils/helpers';
import { AppDebit, AppErreurMcp, AppInjoignable, AppReseau, SessionApp, type OutilApp, type SessionOutils } from '@/lib/mcp/client-app';

import { jetonDe, type EtatConnexion } from './coffre';
import { CHEMIN_RETOUR_CONNECTEUR } from './oauth';
import { relever, trier } from './outils';
import { connecteur, CONNECTEURS, connecteursOuverts, outilRelu, type Connecteur } from './registre';
import { MCP_MAX_OCTETS, sortieMcp, type Deps } from './sortie';
import { marquer } from './texte';

type Db = Pick<PrismaClient, 'connecteurClient' | 'connexionExterne' | 'connecteurOutilVu' | 'auditLog' | 'user'>;
export type ServiceExterne = { appKey: string; label: string; mcpUrl: string; externe: true };
/** Ce que la porte sait de qui appelle : sa connexion IA a été autorisée par sa propre session, et où il agit. */
export type Demandeur = { hubUserId: string; services?: boolean };
type Espaces = { vivants: { role: string }[]; suspendus: { role: string }[] };

export const retourConnecteur = (): string => getURL(CHEMIN_RETOUR_CONNECTEUR);

/**
 * Un service personnel ne se montre qu'à une IA branchée par la personne elle-même, en le sachant (`services`, posé au consentement) : jamais à Mon IA ni à
 * une connexion née d'une session d'organisation ou d'emprunt. Compte retiré (plus aucun espace vivant) ou suspendu (un espace à lui l'est) : aucun.
 */
export const servicesPermis = (qui: Demandeur, e: Espaces): boolean =>
  connecteursOuverts(qui.hubUserId) && qui.services === true && e.vivants.length > 0 && !e.suspendus.some((x) => x.role === 'proprietaire');

export async function servicesDe(db: Pick<PrismaClient, 'connexionExterne'>, qui: Demandeur, espaces: () => Promise<Espaces>): Promise<ServiceExterne[]> {
  // Les cas les plus courants ne lisent rien : fermé, ou connexion IA sans services.
  if (!connecteursOuverts(qui.hubUserId) || qui.services !== true || !servicesPermis(qui, await espaces())) return [];
  const l = await db.connexionExterne.findMany({ where: { hubUserId: qui.hubUserId, etat: 'active' satisfies EtatConnexion['etat'] }, select: { connecteur: true } });
  return CONNECTEURS.filter((c) => l.some((x) => x.connecteur === c.cle)).map((c) => ({ appKey: c.cle, label: c.nom, mcpUrl: c.mcpUrl, externe: true as const }));
}

/** Une session chez le service, bornée aux outils relus, à ce que la personne a allumé, et à un texte encadré. */
class SessionExterne implements SessionOutils {
  constructor(private readonly s: SessionApp, private readonly c: Connecteur, private readonly db: Db, private readonly hubUserId: string) {}

  /** Relu à chaque fois : éteindre l'écriture, ou couper, vaut pour l'appel suivant. */
  private async ecriture(): Promise<boolean | null> {
    const l = await this.db.connexionExterne.findUnique({ where: { hubUserId_connecteur: { hubUserId: this.hubUserId, connecteur: this.c.cle } }, select: { ecriture: true, etat: true } });
    return l?.etat === 'active' ? l.ecriture : null;
  }

  async outils(): Promise<OutilApp[]> {
    const annonces = await avant(this.s.outils(), LISTE_DELAI_MS).catch((err) => { throw dire(this.c, err); });
    const t = trier(this.c, annonces, (await this.ecriture()) === true);
    await relever(this.db, this.c, t.aRelire).catch((err) => console.error('[connecteur] relevé', err instanceof Error ? err.message.slice(0, 120) : 'erreur'));
    return t.servis;
  }

  async appeler(name: string, args: Record<string, unknown>): Promise<unknown> {
    const relu = outilRelu(this.c, name);
    if (!relu) throw new AppInjoignable(`${name} n'est pas un outil relu de ${this.c.nom}`);
    const ecriture = await this.ecriture();
    if (ecriture === null) throw new AppInjoignable(aRebrancher(this.c));
    if (relu.acces === 'ecriture' && !ecriture) throw new AppInjoignable(`${this.c.nom} est en lecture seule : l'écriture s'allume dans Connexions, par la personne`);
    // La liste lue avant a pu vieillir de cinq minutes : l'outil joué est celui dont la définition est relue MAINTENANT.
    if (!(await this.outils()).some((o) => o.name === name)) throw new AppInjoignable(`${name} a changé chez ${this.c.nom} : il attend notre relecture`);
    try {
      return marquer(this.c, (await this.s.appeler(name, args)) as never);
    } catch (err) {
      // Une erreur de l'outil est aussi un texte du service.
      if (err instanceof AppErreurMcp) return marquer(this.c, { content: [{ type: 'text', text: String(err.message) }], isError: true });
      // Une écriture sans refus net : on ne sait pas. Le dire, sans quoi l'IA la rejoue.
      const refusNet = err instanceof AppDebit || (err instanceof AppInjoignable && err.statut !== undefined && err.statut < 500);
      if (relu.acces === 'ecriture' && !refusNet) throw new AppInjoignable(`${this.c.nom} n'a pas répondu correctement : l'action a peut-être eu lieu, le vérifier avant de rejouer`);
      throw dire(this.c, err);
    }
  }
}

/** Vingt pages d'outils à quinze secondes chacune tiendraient toute la porte : la liste entière a un seul délai. */
const LISTE_DELAI_MS = 20_000;
async function avant<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_ok, ko) => { t = setTimeout(() => ko(new AppReseau('délai')), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

const aRebrancher = (c: Connecteur): string => `${c.nom} est à rebrancher : Connexions, dans votre espace Veridian`;
/** Nos mots à nous : rien de ce que le service écrit n'arrive à l'IA par une erreur. */
function dire(c: Connecteur, err: unknown): AppInjoignable {
  if (err instanceof AppErreurMcp || err instanceof AppReseau || !(err instanceof AppInjoignable)) return new AppInjoignable(`${c.nom} ne répond pas correctement`);
  return err.statut === undefined ? err : new AppInjoignable(`${c.nom} refuse (HTTP ${err.statut})`, undefined, err.statut);
}

/** Ouvre une session chez le service. Son refus du jeton vaut UN renouvellement, jamais une boucle. */
export async function sessionExterne(db: Db, qui: Demandeur, cle: string, d: Deps = {}): Promise<SessionOutils> {
  const c = connecteursOuverts(qui.hubUserId) ? connecteur(cle) : null;
  if (!c || qui.services !== true) throw new AppInjoignable('service inconnu');
  const ouvrir = async (force: boolean): Promise<SessionOutils> => {
    const jeton = await jetonDe(db, qui.hubUserId, c, retourConnecteur(), { ...d, force }).catch(() => { throw new AppInjoignable(`${c.nom} ne répond pas`); });
    if (!jeton) throw new AppInjoignable(aRebrancher(c));
    const s = new SessionApp(c.mcpUrl, jeton, sortieMcp(c, d) as never, { maxOctets: MCP_MAX_OCTETS });
    await s.ouvrir();
    return new SessionExterne(s, c, db, qui.hubUserId);
  };
  try {
    return await ouvrir(false);
  } catch (err) {
    if (!(err instanceof AppInjoignable) || err.statut !== 401) throw dire(c, err);
    return ouvrir(true).catch((e) => { throw dire(c, e); });
  }
}
