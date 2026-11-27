/**
 * Mode programme de la porte MCP (docs/CONTRAT-MCP.md) : le code du client tourne hors du Hub (programme/), et chaque
 * `outil(...)` revient ici. Rien de ce que dit l'exécuteur n'est cru : les noms, les tailles, le nombre d'appels, la durée
 * et les droits se décident de ce côté. Le seul effet d'un programme, ce sont ces appels, joués avec l'identité de
 * l'appelant, dans l'espace choisi à l'ouverture, et journalisés un par un.
 */
import { AppDebit, AppInjoignable } from './client-app';
import type { Outil } from './catalogue';
import { compterFenetre, lireFenetre, viderLimiteur } from '@/lib/auth/compteurs';
import { verrouCourant } from './verrou-programme';

export const DELAI_MS = 45_000;
export const APPELS_MAX = 200;
export const DE_FRONT = 4;
export const REPONSE_MAX_OCTETS = 1_000_000;
export const CODE_MAX_CAR = 100_000;
export const ETAT_MAX_CAR = 2_000;
export const AUTORISER_MAX = 50;
const LIGNE_MAX_CAR = 2_000_000;
const RESULTAT_MAX_CAR = 11_000;
const JOURNAL_MAX_CAR = 1_500;
const MESSAGES_MAX = 5_000;
/** Octets d'arguments en attente d'une place : au-delà, l'appel est refusé (la mémoire du Hub n'est pas une file). */
const ATTENTE_MAX_CAR = 8_000_000;
const RELANCES_DEBIT = 5;
/** Appels internes par minute et par utilisateur : vérifié AVANT de lancer un programme, jamais à mi-course. */
export const APPELS_MINUTE_MAX = 600;

export type Moteur = { envoyer: (m: Record<string, unknown>) => void; surLigne: (f: (ligne: string) => void) => void; surFin: (f: () => void) => void; fermer: () => void };
export type OuvrirMoteur = (programme: string, ligneMax: number) => Promise<Moteur | null>;

export type Contenu = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: unknown };

export type Bilan = {
  etat: 'termine' | 'interrompu' | 'erreur' | 'non_lance';
  raison?: string;
  resultat?: unknown;
  erreur?: string;
  reprise?: unknown;
  appels: { faits: number; reussis: number; echoues: number; issue_inconnue: string[] };
  duree_ms: number;
  journal: string[];
};

/**
 * Un outil se joue sans être nommé dans `autoriser` s'il se déclare en lecture seule, et seulement alors. « Non destructif » ne
 * suffit pas : Twenty le dit de toutes ses écritures, create_webhook et delete_many compris (24/11). Sans annotation, ou avec des
 * annotations qui se contredisent : il faut le nommer. Et une app n'est pas crue sur parole : un outil qui se dit lecture et porte un
 * verbe d'écriture dans son nom se nomme aussi (delete_many_people annoté lecture par erreur).
 */
export function exigeAutorisation(o: Pick<Outil, 'annotations' | 'local'>): boolean {
  const a = (o.annotations ?? {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
  return a.readOnlyHint !== true || a.destructiveHint === true || nomDEcriture(o.local);
}

const VERBES_ECRITURE = new Set(
  ('add apply approve archive assign attach cancel close complete copy create delete detach destroy disable drop duplicate edit enable execute import insert install invite ' +
    'merge modify move patch post publish purge put remove rename replace reset restore revoke run save schedule send set start stop submit subscribe sync trigger truncate ' +
    'unarchive uninstall unsubscribe update upload upsert write ' +
    'accorder activer ajouter annuler archiver creer definir deplacer desactiver detruire ecrire envoyer epingler executer fusionner importer installer inviter modifier programmer ' +
    'publier regler relancer remplacer renommer restaurer retirer revoquer supprimer vider').split(' '),
);

/** Un mot entier du nom est un verbe d'écriture : contacts_import, deleteMany, créer_segment ; pas sent_messages ni settings. */
export function nomDEcriture(local: string): boolean {
  const mots = local.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return mots.some((m) => VERBES_ECRITURE.has(m));
}

/** Un texte qui commence comme un objet ou une liste JSON (jamais « [note] » ni « [1] voir »). */
const DEBUT_JSON = /^\s*(\{\s*["}]|\[\s*[[{"])/;

const seLit = (t: string): boolean => {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};

/**
 * Ce que le programme reçoit d'un outil : sa donnée structurée, sinon son texte, lu en JSON s'il en est. Un JSON commencé et
 * illisible est une réponse COUPÉE par l'app : une erreur, jamais un texte que le code prendrait pour une donnée (24/11,
 * Prospection coupait à 15 000 caractères).
 */
export function valeurDe(r: Contenu): unknown {
  const texte = (r.content ?? []).map((c) => (c?.type === 'text' ? c.text : '')).join('\n');
  if (r.isError) throw new Error(texte.slice(0, 2_000) || "erreur de l'outil");
  if (r.structuredContent !== undefined) return r.structuredContent;
  try {
    return JSON.parse(texte);
  } catch {
    // Plusieurs blocs dont l'un se lit entier : ce n'est pas une coupe, le texte est rendu tel quel.
    if (!DEBUT_JSON.test(texte) || (r.content ?? []).some((c) => c?.type === 'text' && typeof c.text === 'string' && DEBUT_JSON.test(c.text) && seLit(c.text))) return texte;
    throw new Error(`l'app a coupé sa réponse (${texte.length} caractères, JSON illisible). L'appel a été joué : demander moins de lignes ou de colonnes, ne pas le refaire à l'aveugle s'il écrit`);
  }
}

// ── Un programme à la fois par utilisateur, et un budget d'appels par minute ─────────────────

/** Compteur des appels d'un compte, par minute, partagé entre instances. */
const LIMITEUR_APPELS = 'programme-appels';
const FENETRE_APPELS_MS = 60_000;

/** Efface le budget d'appels (tests). Le verrou de programme se libère avec chaque programme. */
export function oublierProgrammes(): Promise<void> {
  return viderLimiteur(LIMITEUR_APPELS);
}

/**
 * Prend la place de l'utilisateur, ou dit pourquoi pas. Un programme à la fois par compte (verrou partagé, lib/mcp/verrou-programme.ts)
 * et budget d'appels par minute (compteur partagé). Le verrou est pris d'abord ; si le budget refuse, il est rendu aussitôt.
 */
export async function prendrePlace(
  utilisateur: string,
  maintenant = Date.now(),
): Promise<{ ok: true; rendre: () => Promise<void> } | { ok: false; message: string }> {
  const prise = await verrouCourant().prendre(utilisateur);
  if (!prise.ok) {
    if (prise.raison === 'occupe') return { ok: false, message: 'Un programme de ce compte est déjà en cours : attendre sa fin (45 s au plus).' };
    console.error('[programme-verrou] indisponible', prise.erreur ?? '');
    return { ok: false, message: 'Le verrou des programmes ne répond pas : réessayer dans un instant.' };
  }
  let compte: number;
  let resetAt: number;
  try {
    ({ compte, resetAt } = await lireFenetre(LIMITEUR_APPELS, utilisateur, FENETRE_APPELS_MS, maintenant));
  } catch (err) {
    console.error('[programme-budget] indisponible', err instanceof Error ? err.message : err);
    await prise.liberer();
    return { ok: false, message: 'Le budget d\'appels ne répond pas : réessayer dans un instant.' };
  }
  if (compte >= APPELS_MINUTE_MAX) {
    await prise.liberer();
    return { ok: false, message: `Trop d'appels par programme en une minute : réessayer dans ${Math.max(1, Math.ceil((resetAt - maintenant) / 1000))} s.` };
  }
  return { ok: true, rendre: prise.liberer };
}

export type DemandeProgramme = {
  id: string;
  utilisateur: string;
  code: string;
  reprise: unknown;
  autoriser: ReadonlySet<string>;
  trouver: (nom: string) => Outil | { injoignable: string } | undefined;
  /** Joue un outil : mêmes droits et même journal que executer_outil. `signal` : abandon à l'échéance. */
  jouer: (o: Outil, args: Record<string, unknown>, signal: AbortSignal) => Promise<Contenu>;
  ouvrirMoteur: OuvrirMoteur;
  delaiMs?: number;
};

export async function executerProgramme(d: DemandeProgramme): Promise<Bilan> {
  const debut = Date.now();
  const delaiMs = d.delaiMs ?? DELAI_MS;
  const bilan: Bilan = { etat: 'erreur', appels: { faits: 0, reussis: 0, echoues: 0, issue_inconnue: [] }, duree_ms: 0, journal: [] };
  const moteur = await d.ouvrirMoteur(d.id, LIGNE_MAX_CAR);
  if (!moteur) return { ...bilan, etat: 'non_lance', raison: 'moteur_indisponible', duree_ms: Date.now() - debut };

  const abandon = new AbortController();
  const enVol = new Map<number, string>();
  const attente: (() => void)[] = [];
  const connus = new Set<number>();
  let attenteCar = 0;
  let clos = false;
  let actifs = 0;
  let messages = 0;
  let journalCar = 0;
  let termine = false;

  return new Promise<Bilan>((rendre) => {
    const conclure = (m: Partial<Bilan>) => {
      if (termine) return;
      termine = true;
      clearTimeout(minuteur);
      Object.assign(bilan, m, { duree_ms: Date.now() - debut });
      bilan.appels.issue_inconnue = Array.from(enVol.values());
      abandon.abort();
      moteur.fermer();
      rendre(bilan);
    };
    const minuteur = setTimeout(() => conclure({ etat: 'interrompu', raison: 'delai' }), Math.max(0, delaiMs - (Date.now() - debut)));

    const suivant = () => {
      while (!termine && actifs < DE_FRONT && attente.length) {
        actifs += 1;
        attente.shift()!();
      }
    };

    async function jouerAvecDebit(o: Outil, args: Record<string, unknown>): Promise<Contenu> {
      for (let essai = 0; ; essai++) {
        try {
          return await d.jouer(o, args, abandon.signal);
        } catch (err) {
          // 429 : rien n'a été joué chez l'app. On attend ce qu'elle demande plutôt que de faire échouer le programme.
          if (!(err instanceof AppDebit) || essai >= RELANCES_DEBIT || termine) throw err;
          await new Promise((r) => setTimeout(r, err.attenteMs));
          if (termine) throw err;
        }
      }
    }

    function refuser(id: unknown, erreur: string) {
      bilan.appels.echoues += 1;
      moteur!.envoyer({ t: 'reponse', id, ok: false, erreur });
    }

    function appel(m: Record<string, unknown>, taille: number) {
      const id = m.id;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || connus.has(id)) return conclure({ etat: 'erreur', raison: 'executeur_incoherent' });
      if (bilan.appels.faits >= APPELS_MAX) return refuser(id, `plafond de ${APPELS_MAX} appels par programme atteint : sauver(où on en est) puis relancer avec reprise`);
      connus.add(id);
      if (attenteCar + taille > ATTENTE_MAX_CAR) return refuser(id, "trop de données en attente : attendre (await) les appels lancés avant d'en lancer d'autres");
      bilan.appels.faits += 1;
      const nom = typeof m.nom === 'string' ? m.nom.slice(0, 200) : '';
      const args = m.args && typeof m.args === 'object' && !Array.isArray(m.args) ? (m.args as Record<string, unknown>) : {};
      const o = d.trouver(nom);
      if (!o) return refuser(id, `Outil inconnu : ${nom}. Un programme appelle les outils rendus par chercher_outils (<app>.<outil>).`);
      if ('injoignable' in o) return refuser(id, o.injoignable);
      if (exigeAutorisation(o) && !d.autoriser.has(o.nom)) return refuser(id, `${o.nom} modifie des données (ou ne dit pas qu'il ne le fait pas) : le nommer dans autoriser`);
      attenteCar += taille;
      attente.push(() => {
        enVol.set(id, o.nom);
        attenteCar -= taille;
        // Le budget se compte avant de jouer ; s'il ne peut pas l'être, l'appel n'est PAS joué (refus fermé).
        compterFenetre(LIMITEUR_APPELS, d.utilisateur, FENETRE_APPELS_MS, Date.now())
          .catch(() => {
            throw new Error("budget d'appels indisponible : appel non joué, réessayer");
          })
          .then(() => jouerAvecDebit(o, args))
          .then((r) => valeurDe(r))
          .then(
            (valeur) => {
              if (termine) return;
              bilan.appels.reussis += 1;
              moteur!.envoyer({ t: 'reponse', id, ok: true, valeur });
            },
            (err) => {
              if (termine) return;
              const message = err instanceof AppInjoignable ? `Échec de ${o.nom} : ${err.message}.` : err instanceof Error ? err.message : 'erreur';
              refuser(id, message);
            },
          )
          .finally(() => {
            if (!termine) enVol.delete(id);
            actifs -= 1;
            suivant();
          });
      });
      suivant();
    }

    moteur.surFin(() => conclure({ etat: 'erreur', raison: 'moteur_arrete', erreur: 'le moteur a arrêté le programme (mémoire, fin anormale ou mise à jour) : avec une reprise, relancer une fois' }));
    moteur.surLigne((ligne) => {
      if (termine || clos) return;
      if (++messages > MESSAGES_MAX) return conclure({ etat: 'erreur', raison: 'trop_de_messages' });
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(ligne) as Record<string, unknown>;
      } catch {
        return conclure({ etat: 'erreur', raison: 'executeur_incoherent' });
      }
      switch (m?.t) {
        case 'appel':
          return appel(m, ligne.length);
        case 'etat': {
          const t = JSON.stringify(m.valeur ?? null);
          if (t.length <= ETAT_MAX_CAR) bilan.reprise = m.valeur;
          else bilan.journal.push(`sauver : état de ${t.length} caractères refusé (${ETAT_MAX_CAR} au plus)`);
          return;
        }
        case 'journal': {
          const t = String(m.texte ?? '').slice(0, 300);
          if (journalCar + t.length <= JOURNAL_MAX_CAR) {
            journalCar += t.length;
            bilan.journal.push(t);
          }
          return;
        }
        case 'occupe':
          return conclure({ etat: 'non_lance', raison: 'occupe' });
        case 'fin': {
          clos = true;
          const fin = (): Partial<Bilan> => (m.ok === true ? { etat: 'termine', resultat: m.valeur } : { etat: 'erreur', erreur: String(m.erreur ?? 'erreur').slice(0, 2_000) });
          // Appels lancés sans await : on attend leur issue plutôt que de la perdre.
          const guet = setInterval(() => {
            if (termine || (enVol.size === 0 && attente.length === 0)) {
              clearInterval(guet);
              conclure(fin());
            }
          }, 20);
          moteur.surFin(() => {});
          return;
        }
        default:
          return conclure({ etat: 'erreur', raison: 'executeur_incoherent' });
      }
    });
    moteur.envoyer({ t: 'programme', code: d.code, reprise: d.reprise ?? null });
  });
}

/** Le texte rendu au client : toujours un état, ce qui a été fait, et comment reprendre. Sous SORTIE_MAX_CAR. */
export function presenter(id: string, b: Bilan): Contenu {
  const brut = b.resultat === undefined ? undefined : JSON.stringify(b.resultat);
  const tronque = brut !== undefined && brut.length > RESULTAT_MAX_CAR;
  const inconnus = b.appels.issue_inconnue;
  const conseils = [
    b.etat === 'interrompu' ? `Arrêté à ${Math.round(b.duree_ms / 1000)} s. Pour continuer : relancer le même code avec reprise = la valeur de « reprise » ci-dessus.` : '',
    b.etat === 'interrompu' && b.reprise === undefined ? "Le programme n'a rien sauvé (sauver(...)) : vérifier ce qui est déjà fait avant de relancer." : '',
    inconnus.length ? "Les appels d'issue inconnue ont pu être joués par l'app : vérifier avant de les refaire." : '',
    tronque ? 'Résultat tronqué : rendre moins de données (un compte, un échantillon).' : '',
    b.raison === 'occupe' ? 'Le moteur est plein : réessayer dans 30 s.' : '',
    b.raison === 'moteur_indisponible' ? 'Le moteur des programmes ne répond pas : réessayer plus tard, ou appeler les outils un par un.' : '',
  ].filter(Boolean);
  const corps = {
    programme: id,
    etat: b.etat,
    ...(b.raison ? { raison: b.raison } : {}),
    ...(brut === undefined ? {} : tronque ? { resultat: brut.slice(0, RESULTAT_MAX_CAR), resultat_tronque: true } : { resultat: b.resultat }),
    ...(b.erreur ? { erreur: b.erreur.slice(0, 1_000) } : {}),
    ...(b.reprise !== undefined ? { reprise: b.reprise } : {}),
    appels: { ...b.appels, issue_inconnue: inconnus.slice(0, DE_FRONT * 2) },
    duree_ms: b.duree_ms,
    ...(b.journal.length ? { journal: b.journal.slice(0, 30) } : {}),
    ...(conseils.length ? { conseil: conseils.join(' ') } : {}),
  };
  return { content: [{ type: 'text', text: JSON.stringify(corps) }], ...(b.etat === 'erreur' || b.etat === 'non_lance' ? { isError: true } : {}) };
}
