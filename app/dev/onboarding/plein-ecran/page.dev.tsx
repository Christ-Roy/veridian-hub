import { QualificationPreview } from './QualificationPreview';

/**
 * Parcours de qualification rendu SEUL, en plein écran.
 *
 * Hérite du garde-fou de `app/dev/onboarding/layout.dev.tsx` (404 hors
 * développement) et de l'extension `.dev.tsx` qui l'exclut du build prod.
 *
 * À ouvrir directement dans le navigateur pour juger du responsive réel :
 * c'est le seul contexte où `100dvh` vaut la hauteur du viewport, barre
 * d'adresse mobile comprise.
 */
export default async function PleinEcranPage({
  searchParams,
}: {
  searchParams: Promise<{ repris?: string }>;
}) {
  const { repris } = await searchParams;
  return <QualificationPreview repris={repris === '1'} />;
}
