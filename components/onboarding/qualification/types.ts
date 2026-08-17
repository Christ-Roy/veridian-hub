/**
 * Onboarding qualifiant de première connexion — modèle de données côté UI.
 *
 * La forme colle volontairement à la table `user_onboarding` recommandée par
 * `todo/2026-07-28-recon-onboarding-decisions-archi.md` : jalons typés en
 * colonnes + `metadata` libre. Le jour du branchement, on remplace la source
 * (mock → Prisma) sans réécrire les composants.
 */

import type { CleIllustration } from './illustrations';

/** Réponse à « Avez-vous déjà un site web ? ». */
export type SiteActuel = 'oui' | 'non';

/** Suite si le client A déjà un site. */
export type IntentionSiteExistant =
  /** Le site fait le job, rien à faire. */
  | 'satisfait'
  /** Refonte du site existant. */
  | 'refonte'
  /** Passer à une application web (fonctionnalités, comptes, back-office). */
  | 'application';

/** Suite si le client n'a PAS de site. */
export type IntentionSansSite =
  | 'vitrine'
  | 'boutique'
  | 'application'
  | 'indecis';

/** Intérêt pour l'emailing (Veridian Mail). */
export type InteretEmailing =
  /** Déjà une liste de contacts à exploiter. */
  | 'liste-existante'
  /** Motivé mais part de zéro. */
  | 'depuis-zero'
  /** Pas maintenant. */
  | 'plus-tard';

/** Intérêt pour la base B2B de prospection (Veridian Prospection). */
export type InteretProspection =
  /** Priorité affichée : trouver des clients. */
  | 'priorite'
  /** Curieux, à explorer. */
  | 'explorer'
  /** Vend aux particuliers : la base d'entreprises n'a pas de sens. */
  | 'b2c'
  | 'plus-tard';

/**
 * Échéance du chantier déclaré. Posée en dernier, et seulement si le client
 * a déclaré au moins un chantier : c'est la seule information qui change
 * l'ordre des appels de Robert le lendemain matin, et elle ne coûte rien en
 * abandon (elle n'engage à rien, elle ne demande aucun chiffre, et elle
 * arrive quand le client est déjà investi).
 */
export type Echeance =
  /** Ça doit avancer maintenant. */
  | 'urgent'
  /** Prévu, sans urgence. */
  | 'trimestre'
  /** Regarde, sans date. */
  | 'sans-date';

/**
 * Les réponses de qualification. Persistées dans
 * `user_onboarding.metadata.qualification` (clé JSON), pas en colonnes : ce
 * sont des réponses métier mouvantes, pas des jalons durables. C'est
 * exactement l'usage prévu pour `metadata` par la recon.
 */
export interface Qualification {
  siteActuel?: SiteActuel;
  intentionSiteExistant?: IntentionSiteExistant;
  intentionSansSite?: IntentionSansSite;
  emailing?: InteretEmailing;
  prospection?: InteretProspection;
  echeance?: Echeance;
}

/** Une clé de réponse — sert à typer un écran sur la réponse qu'il écrit. */
export type CleQualification = keyof Qualification;

/**
 * Projection UI de la ligne `user_onboarding` (1:1 avec `User`).
 *
 * Les dates sont des chaînes ISO ou `null` : c'est ce que renvoie une
 * sérialisation Prisma → Server Component, donc le composant n'aura rien à
 * changer au branchement.
 */
export interface UserOnboardingRecord {
  userId: string;
  invitedAt: string | null;
  activatedAt: string | null;
  firstAppStartedAt: string | null;
  memberInvitedAt: string | null;
  workspaceRenamedAt: string | null;
  completedAt: string | null;
  metadata: {
    qualification?: Qualification;
    /**
     * Étape en cours, pour reprendre le parcours où il s'est arrêté.
     * Typée sur `EtapeId` et non `string` : une étape renommée doit casser
     * la compilation, pas la reprise du client.
     */
    etapeCourante?: EtapeId;
  } | null;
}

/** Ce que l'UI a besoin de savoir du client connecté. */
export interface OnboardingUser {
  /** Prénom ou début de l'email — sert à personnaliser l'accueil. */
  prenom: string;
  email: string;
  workspaceName: string;
}

/**
 * Identifiant d'un écran du parcours.
 *
 * Les deux branches de la question 2 ont des ids DISTINCTS. Elles ont
 * longtemps partagé `'site-intention'`, ce qui cassait trois choses d'un
 * coup : la `key` React (basculer oui→non ne remontait pas le composant,
 * l'animation d'entrée ne rejouait pas), `metadata.etapeCourante` (qui ne
 * pouvait pas désigner l'écran à reprendre) et tout `find(e => e.id === x)`
 * (qui renvoyait toujours la branche « j'ai un site »).
 */
export type EtapeId =
  | 'accueil'
  | 'site-actuel'
  | 'site-intention-existant'
  | 'site-intention-creation'
  | 'emailing'
  | 'prospection'
  | 'echeance'
  | 'recapitulatif';

/** Une option proposée sur un écran de question. */
export interface OptionQuestion<V extends string = string> {
  value: V;
  label: string;
  /** Une ligne, orientée bénéfice client — jamais de jargon interne. */
  description: string;
}

/**
 * Spécification d'un écran de question, TYPÉE SUR LA CLÉ qu'elle écrit.
 *
 * `K` n'est pas décoratif : c'est lui qui fait que `value: 'oiu'` ne compile
 * pas. Avant, `options: OptionQuestion[]` dégénérait en `value: string` et
 * `ecrire` rattrapait le tout avec un `as` — le découplage par données tenait
 * sur la forme, mais le compilateur ne rattrapait plus rien. Le seul endroit
 * qui accepte encore une `string` large est `repondre()` dans `questions.ts`,
 * qui reçoit la valeur d'un clic (donc forcément une chaîne) et fait le
 * rétrécissement UNE fois, commenté.
 */
export interface EcranQuestion<K extends CleQualification = CleQualification> {
  id: EtapeId;
  /** La réponse écrite par cet écran. */
  cle: K;
  /** Titre affiché, formulé comme une question posée au client. */
  titre: (user: OnboardingUser) => string;
  /** Sous-titre facultatif : pourquoi on pose la question. */
  sousTitre?: string;
  /** Clé de l'illustration — une clé inconnue ne compile pas. */
  illustration: CleIllustration;
  options: OptionQuestion<NonNullable<Qualification[K]>>[];
  /** Lit la réponse déjà donnée. */
  lire: (q: Qualification) => Qualification[K];
  /** Écrit la réponse choisie. */
  ecrire: (q: Qualification, value: NonNullable<Qualification[K]>) => Qualification;
  /** L'écran est-il pertinent au vu des réponses précédentes ? */
  pertinent?: (q: Qualification) => boolean;
}

/**
 * Un écran quelconque du parcours : l'union de toutes les spécialisations.
 *
 * C'est ce type-là qui circule dans les listes et dans les composants. Il
 * garde la trace du lien entre `cle`, `options` et `ecrire` — un tableau de
 * `EcranQuestion<CleQualification>` l'aurait perdu.
 */
export type EcranQuestionQuelconque = {
  [K in CleQualification]-?: EcranQuestion<K>;
}[CleQualification];
