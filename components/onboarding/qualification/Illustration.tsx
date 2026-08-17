'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { ImageIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { getIllustration } from './illustrations';
import { Pictogramme } from './Pictogramme';

/**
 * Emplacement d'illustration d'un écran d'onboarding.
 *
 * Trois rendus, dans cet ordre de priorité :
 *
 *  1. **Sous `lg` : le pictogramme vectoriel.** Une capture de dashboard
 *     affichée à 343×146 px est une bouillie de pixels — le texte de
 *     l'interface capturée y mesure environ 4 px de haut. Quatre questions,
 *     quatre rectangles indistincts, pour 18 à 24 % de la hauteur volés aux
 *     réponses. Le dessin, lui, tient sa lisibilité à 120 px et hérite des
 *     couleurs du thème (donc pas de bloc blanc éblouissant en sombre).
 *  2. **À partir de `lg` : la capture**, variante sombre si elle existe.
 *     Toutes les captures de `public/onboarding/apps/` sont prises en thème
 *     clair ; tant que les variantes sombres ne sont pas déposées, on reste
 *     sur le pictogramme en sombre plutôt que d'éblouir le client avec la
 *     zone la plus lumineuse de la page.
 *  3. **Fichier absent : le pictogramme**, à toutes les largeurs (et le
 *     cadre légendé seulement si la clé elle-même est inconnue).
 *
 * Volontairement en `<img>` et non `next/image` : `next/image` ne sait pas
 * retomber proprement sur un emplacement quand le fichier manque.
 */
export function Illustration({
  cle,
  className,
}: {
  cle: string;
  className?: string;
}) {
  const spec = getIllustration(cle);
  const { resolvedTheme } = useTheme();
  const sombre = resolvedTheme === 'dark';

  // En sombre, on n'utilise la capture QUE si sa variante sombre existe.
  const srcGrandEcran = sombre ? spec.srcSombre : spec.src;
  const srcCompact = sombre ? spec.srcCompactSombre : spec.srcCompact;

  const [manquante, setManquante] = useState(!srcGrandEcran);

  // Changer d'écran (ou de thème) doit re-tenter le chargement du visuel.
  useEffect(() => {
    setManquante(!srcGrandEcran);
  }, [srcGrandEcran]);

  const capture = !manquante && srcGrandEcran;

  if (!capture) {
    // Clé inconnue du registre : on garde le cadre légendé, qui sert à
    // repérer un branchement raté pendant le travail d'atelier.
    if (!spec.alt) {
      return (
        <div
          className={cn(
            'flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-card/70 p-4 text-center',
            className,
          )}
          role="img"
          aria-label={spec.attendu}
        >
          <ImageIcon className="h-6 w-6 text-muted-foreground" aria-hidden />
          <span className="text-xs text-muted-foreground">{spec.attendu}</span>
        </div>
      );
    }

    // Aucune capture utilisable : le dessin porte l'écran à toutes les
    // largeurs. Il vaut mieux qu'un cadre pointillé vide.
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <Pictogramme cle={spec.pictogramme} titre={spec.alt} className="max-h-full" />
      </div>
    );
  }

  return (
    <div className={cn('h-full w-full', className)}>
      {/* Mobile et tablette : le dessin. */}
      <div className="flex h-full w-full items-center justify-center lg:hidden">
        <Pictogramme cle={spec.pictogramme} titre={spec.alt} className="max-h-full" />
      </div>

      {/* Grand écran : la capture. Aucun cadre, aucune ombre, aucun arrondi
          ajoutés ici — les visuels sont livrés en PNG alpha avec leurs
          propres coins arrondis, liseré et ombre portée (consigne du
          manifeste). En rajouter donnerait un double cadre. */}
      <picture className="hidden h-full w-full lg:block">
        {srcCompact && <source media="(max-width: 1279px)" srcSet={srcCompact} />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={srcGrandEcran}
          alt={spec.alt}
          onError={() => setManquante(true)}
          draggable={false}
          className="h-full w-full select-none object-contain"
        />
      </picture>
    </div>
  );
}
