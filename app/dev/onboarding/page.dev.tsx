import type { OnboardingStateId } from '@/components/onboarding';

import { OnboardingHarness } from './OnboardingHarness';

const ETATS_VALIDES: OnboardingStateId[] = [
  'activation',
  'mot-de-passe',
  'en-cours',
  'termine',
  'erreur',
  'token-expire',
];

/**
 * Atelier de prévisualisation du flow d'onboarding.
 *
 * Le fichier s'appelle `page.dev.tsx` : cette extension n'est reconnue comme
 * page que hors production (cf. `pageExtensions` dans `next.config.js`), donc
 * la route n'existe tout simplement pas dans un build prod. Le layout ajoute
 * un second verrou au runtime.
 *
 * `?etat=<id>` permet d'ouvrir directement un écran précis.
 */
export default async function DevOnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ etat?: string }>;
}) {
  const { etat } = await searchParams;
  const etatInitial = ETATS_VALIDES.includes(etat as OnboardingStateId)
    ? (etat as OnboardingStateId)
    : 'activation';

  return <OnboardingHarness etatInitial={etatInitial} />;
}
