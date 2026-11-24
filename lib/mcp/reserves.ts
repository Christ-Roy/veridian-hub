/**
 * Outils qu'un programme n'appelle JAMAIS, même nommés dans `autoriser` (parente, 25/11) : membres, rôles, clés, webhooks, apps, réglages
 * de l'espace. Tenu par MOTIF (un sujet réservé dans le nom, et l'outil n'est pas une lecture), pas par une liste de noms : une app qui
 * ajoute un outil de cette famille est couverte sans nous prévenir. En appel direct par l'IA ils restent possibles, sauf ceux qui créent,
 * modifient ou suppriment un UTILISATEUR ou une appartenance : cela ne se fait qu'au Hub (Robert, 06/11).
 */
import type { Outil } from './catalogue';
import { exigeAutorisation } from './programme';

const mots = (local: string): string[] => local.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const jeu = (s: string) => new Set(s.split(' '));

const PERSONNES = jeu('user users utilisateur utilisateurs member members membre membres');
/** Sujets qui suffisent : écrire dessus, c'est administrer. */
const SUJETS = jeu('role roles permission permissions acces access webhook webhooks token tokens team teams invitation invitations sso relay smtp imap dns domain domains domaine domaines integration integrations settings setting reglage reglages config configuration parametre parametres espace espaces workspace workspaces tenant tenants site sites organization organizations organisation organisations apikey apikeys');
/** Sujets qui ne comptent qu'accompagnés : « clé » d'API, « app » qu'on installe. */
const CLES = jeu('key keys cle cles');
const API = jeu('api secret');
const APPS = jeu('app apps application applications plugin plugins');
const GESTES_APP = jeu('install uninstall publish unpublish upgrade installer desinstaller publier');

export type Famille = 'personnes' | 'administration';

/** La famille réservée d'un outil, ou null. Une lecture n'est jamais réservée. */
export function familleReservee(o: Pick<Outil, 'annotations' | 'local'>): Famille | null {
  if (!exigeAutorisation(o)) return null;
  const m = mots(o.local);
  const a = (s: Set<string>) => m.some((x) => s.has(x));
  if (a(PERSONNES)) return 'personnes';
  if (a(SUJETS) || (a(CLES) && a(API)) || (a(APPS) && a(GESTES_APP))) return 'administration';
  return null;
}

/** Gestes sur une personne qui n'appartiennent qu'au Hub, même en appel direct. */
const GESTES_IDENTITE = jeu('add create delete remove invite upsert update attach detach grant ajouter creer supprimer retirer inviter modifier rattacher');
/**
 * Refusé en appel direct : Analytics seulement (Robert, 06/11 ; parente, 25/11). Le CRM a sa propre règle (rôle porté par le Hub), un
 * `update_one_workspace_member` y règle aussi une préférence d'affichage.
 */
const APPS_SANS_IDENTITE = new Set(['analytics']);
export function reserveAuHub(o: Pick<Outil, 'annotations' | 'local' | 'app'>): boolean {
  return APPS_SANS_IDENTITE.has(o.app) && familleReservee(o) === 'personnes' && mots(o.local).some((x) => GESTES_IDENTITE.has(x));
}
