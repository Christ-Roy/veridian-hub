/**
 * Jeux de données FICTIVES pour l'atelier `/dev/onboarding`.
 *
 * Aucune de ces valeurs ne correspond à un client réel : ce module ne doit
 * jamais être importé par du code de production. Il alimente uniquement le
 * harnais de développement, qui est lui-même exclu du build prod.
 */

import type { OnboardingInvite, OnboardingStep } from './types';

/** Invitation type : un client provisionné par l'admin, avec deux apps. */
export const MOCK_INVITE: OnboardingInvite = {
  email: 'claire.dubois@exemple-client.fr',
  workspaceName: 'Atelier Dubois',
  invitedBy: 'Robert Brunon',
  apps: [
    {
      id: 'notifuse',
      label: 'Mail',
      suffix: '.mail',
      tagline: 'Vos emails transactionnels et vos campagnes, au même endroit.',
    },
    {
      id: 'prospection',
      label: 'Prospection',
      suffix: '.prospection',
      tagline: 'Trouvez et qualifiez vos prospects sans quitter votre espace.',
    },
  ],
  // Volontairement figée : un atelier doit rendre la même chose à chaque
  // rechargement, sinon on ne peut pas comparer deux itérations d'UI.
  expiresAt: '2026-08-15T18:00:00.000Z',
};

/** Provisioning à mi-parcours : une étape faite, une en cours, deux à venir. */
export const MOCK_STEPS_EN_COURS: OnboardingStep[] = [
  {
    id: 'compte',
    label: 'Création de votre compte',
    status: 'termine',
    detail: 'Mot de passe enregistré et chiffré.',
  },
  {
    id: 'espace',
    label: 'Préparation de votre espace de travail',
    status: 'en-cours',
    detail: 'Quelques secondes, on installe vos outils.',
  },
  {
    id: 'apps',
    label: 'Activation de vos applications',
    status: 'a-venir',
  },
  {
    id: 'bienvenue',
    label: 'Envoi de votre email de bienvenue',
    status: 'a-venir',
  },
];

/** Provisioning terminé : les quatre étapes au vert. */
export const MOCK_STEPS_TERMINE: OnboardingStep[] = MOCK_STEPS_EN_COURS.map(
  (step) => ({ ...step, status: 'termine', detail: undefined }),
);

/** Provisioning tombé en panne sur l'activation des apps. */
export const MOCK_STEPS_ECHEC: OnboardingStep[] = [
  { id: 'compte', label: 'Création de votre compte', status: 'termine' },
  {
    id: 'espace',
    label: 'Préparation de votre espace de travail',
    status: 'termine',
  },
  {
    id: 'apps',
    label: 'Activation de vos applications',
    status: 'echec',
    detail: 'Le service n’a pas répondu.',
  },
  { id: 'bienvenue', label: 'Envoi de votre email de bienvenue', status: 'a-venir' },
];
