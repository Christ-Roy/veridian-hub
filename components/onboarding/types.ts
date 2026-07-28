/**
 * Types du flow d'onboarding « première connexion client » (ticket
 * `todo/2026-07-06-onboarding-premiere-connexion-client.md`).
 *
 * Ces types décrivent UNIQUEMENT ce que l'UI a besoin de savoir. Aucun
 * couplage à Prisma, Auth.js ou au schéma DB : la future page réelle
 * `/onboard/[token]` chargera le token côté serveur et projettera son
 * résultat dans ces structures. C'est ce découplage qui permet de faire
 * tourner l'atelier `/dev/onboarding` sans session ni base de données.
 */

/** Les états dans lesquels un écran d'onboarding peut se trouver. */
export type OnboardingStateId =
  /** Le lien est valide, le compte existe mais n'est pas encore activé. */
  | 'activation'
  /** Le client doit choisir son mot de passe. */
  | 'mot-de-passe'
  /** Activation en cours : provisioning des apps, étape par étape. */
  | 'en-cours'
  /** Tout est prêt, le client peut entrer dans son espace. */
  | 'termine'
  /** Erreur technique (provisioning KO, réseau, 500…). */
  | 'erreur'
  /** Le lien d'invitation a dépassé sa durée de validité. */
  | 'token-expire';

/** Une app Veridian liée au compte pendant l'onboarding. */
export interface OnboardingApp {
  /** Identifiant technique (`notifuse`, `prospection`, `analytics`…). */
  id: string;
  /** Libellé affiché au client. */
  label: string;
  /** Suffixe de marque affiché après le badge Veridian (ex. `.mail`). */
  suffix: string;
  /** Phrase d'accroche, une ligne, orientée bénéfice client. */
  tagline: string;
}

/** Les données portées par un lien d'onboarding, telles que l'UI les voit. */
export interface OnboardingInvite {
  /** Email du destinataire (non modifiable : il vient du lien signé). */
  email: string;
  /** Nom de l'espace de travail provisionné pour le client. */
  workspaceName: string;
  /** Qui a envoyé l'invitation (affiché pour rassurer le destinataire). */
  invitedBy: string;
  /** Apps déjà rattachées au compte. */
  apps: OnboardingApp[];
  /** Date limite d'utilisation du lien (ISO 8601). */
  expiresAt: string;
}

/** Statut d'une étape d'activation affichée dans l'écran « en cours ». */
export type OnboardingStepStatus = 'termine' | 'en-cours' | 'a-venir' | 'echec';

/** Une étape du provisioning, affichée en direct pendant l'activation. */
export interface OnboardingStep {
  id: string;
  label: string;
  status: OnboardingStepStatus;
  /** Détail affiché sous le libellé (facultatif). */
  detail?: string;
}
