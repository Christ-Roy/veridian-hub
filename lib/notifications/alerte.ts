/**
 * Alerte applicative du Hub : UNE ligne JSON sur stdout, rien d'autre (Robert, 23/11 puis 27/11 : Grafana seule source d'alertes, plus rien
 * sur Telegram ; fiche nomad-veridian/docs/claude/37). Nomad envoie stdout à Loki ; une règle Grafana reprend `flux=alerte`.
 *
 * Forme (les champs `flux`, `gravite`, `service`, `impact`, `source` portent les mêmes noms que les étiquettes de `alerte-loki.py` ;
 * `message`, `detail`, `dedup` ceux de son corps) :
 *   {"flux":"alerte","gravite":"critique|erreur|avertissement|info","service":"hub","impact":"client|interne","source":"hub-app",
 *    "evenement":"stripe.propagation_ko","message":"...","dedup":"<16 hex>","detail":{...identifiants...},"ts":"ISO"}
 *
 * Règles : `critique` ne vaut que pour ce qui touche un client réel (impact `client`, pas de compte d'essai) : sinon plafonné à `erreur`.
 * Aucune adresse dans la ligne (dépôt et journaux CI publics) : le texte et les détails sont purgés de toute forme d'adresse. Ne lève jamais.
 */
import { createHash } from 'node:crypto';

export type Gravite = 'critique' | 'erreur' | 'avertissement' | 'info';
export type Detail = Record<string, string | number | boolean | null | undefined>;

export interface AlerteEntree {
  gravite: Gravite;
  /** Nom stable de l'événement, `domaine.cas` : sert à regrouper et à dédoublonner. */
  evenement: string;
  /** Une phrase, sans adresse. */
  message: string;
  /** `client` : un client réel est touché. Défaut `interne`. */
  impact?: 'client' | 'interne';
  /** Vrai : compte d'essai, organisation de test ou Stripe test. Interdit `critique`. */
  essai?: boolean;
  /** Identifiants seulement (tenant, événement, client Stripe, hub_user_id). */
  detail?: Detail;
  /** Clé de dédoublonnage ; défaut : empreinte de l'événement et de ses identifiants. */
  dedup?: string;
}

export interface AlerteLigne {
  flux: 'alerte';
  gravite: Gravite;
  service: 'hub';
  impact: 'client' | 'interne';
  source: 'hub-app';
  evenement: string;
  message: string;
  dedup: string;
  detail: Record<string, string | number | boolean | null>;
  ts: string;
}

const ADRESSE = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g;

/** Retire toute forme d'adresse d'un texte. */
export function sansAdresse(texte: string): string {
  return texte.replace(ADRESSE, '[adresse]');
}

/** Plafonne `critique` : seul un client réel, hors essai, le mérite. */
export function graviteRetenue(e: Pick<AlerteEntree, 'gravite' | 'impact' | 'essai'>): Gravite {
  if (e.gravite === 'critique' && (e.essai === true || e.impact !== 'client')) return 'erreur';
  return e.gravite;
}

export function construireAlerte(e: AlerteEntree): AlerteLigne {
  const detail: AlerteLigne['detail'] = {};
  for (const [k, v] of Object.entries(e.detail ?? {})) {
    if (v === undefined) continue;
    detail[k] = typeof v === 'string' ? sansAdresse(v).slice(0, 300) : v;
  }
  if (e.essai === true) detail.essai = true;
  const message = sansAdresse(e.message).replace(/\s+/g, ' ').trim().slice(0, 300);
  const dedup = e.dedup ?? createHash('sha256').update(`hub|${e.evenement}|${JSON.stringify(detail)}`).digest('hex').slice(0, 16);
  const gravite = graviteRetenue(e);
  return {
    flux: 'alerte',
    gravite,
    service: 'hub',
    impact: e.essai === true ? 'interne' : (e.impact ?? 'interne'),
    source: 'hub-app',
    evenement: e.evenement,
    message,
    dedup,
    detail,
    ts: new Date().toISOString(),
  };
}

/** Écrit la ligne sur stdout. Ne lève jamais : une alerte ne fait pas planter une route. */
export function emettreAlerte(e: AlerteEntree): void {
  try {
    console.log(JSON.stringify(construireAlerte(e)));
  } catch {
    // rien : l'alerte est best-effort, la route appelante doit répondre
  }
}
