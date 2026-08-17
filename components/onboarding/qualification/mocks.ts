/**
 * Données fictives du parcours de qualification, pour l'atelier `/dev/*`.
 * Jamais importé par du code de production.
 */

import type { OnboardingUser, Qualification, UserOnboardingRecord } from './types';

export const MOCK_USER: OnboardingUser = {
  prenom: 'Claire',
  email: 'claire.dubois@exemple-client.fr',
  workspaceName: 'Atelier Dubois',
};

/** Client qui vient d'activer son compte : rien n'est encore renseigné. */
export const MOCK_ETAT_VIERGE: UserOnboardingRecord = {
  userId: 'usr_atelier_0001',
  invitedAt: '2026-07-20T09:00:00.000Z',
  activatedAt: '2026-07-28T08:30:00.000Z',
  firstAppStartedAt: null,
  memberInvitedAt: null,
  workspaceRenamedAt: null,
  completedAt: null,
  metadata: null,
};

/** Réponses type d'un client qui a un site à refondre et veut prospecter. */
export const MOCK_QUALIFICATION_REMPLIE: Qualification = {
  siteActuel: 'oui',
  intentionSiteExistant: 'refonte',
  emailing: 'liste-existante',
  prospection: 'priorite',
};

/** Parcours déjà entamé — sert à vérifier la reprise et le récapitulatif. */
export const MOCK_ETAT_REPRIS: UserOnboardingRecord = {
  ...MOCK_ETAT_VIERGE,
  metadata: { qualification: MOCK_QUALIFICATION_REMPLIE },
};
