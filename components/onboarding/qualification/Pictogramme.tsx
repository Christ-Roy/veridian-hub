import { cn } from '@/lib/utils';

import type { ClePictogramme } from './illustrations';

/**
 * Dessins vectoriels de l'onboarding — la variante MOBILE des illustrations.
 *
 * Pourquoi ils existent : les captures de dashboard livrées pour les grands
 * écrans deviennent illisibles sur un téléphone (343×146 px pour une source
 * déjà réduite trois fois : le texte de l'interface capturée finit autour de
 * 4 px de haut). Le client voyait quatre rectangles gris-bleu indistincts
 * occupant un cinquième de la hauteur, pendant que ses réponses étaient
 * coupées en bas.
 *
 * Deux propriétés obligatoires, et c'est tout le point :
 *  - ils tiennent leur lisibilité à 120 px de haut ;
 *  - ils héritent des variables de couleur (`currentColor` + classes
 *    sémantiques), donc pas de bloc blanc éblouissant en thème sombre.
 *
 * Server Component : aucun état, aucune interaction.
 */

const TRAIT = 'stroke-current fill-none';

/** Un dessin par thématique. Traits épais, formes larges, zéro micro-détail. */
const DESSINS: Record<ClePictogramme, React.ReactNode> = {
  // Un espace de travail : une fenêtre et ses tuiles d'apps.
  espace: (
    <>
      <rect x="8" y="14" width="104" height="76" rx="8" className={TRAIT} strokeWidth="3" />
      <path d="M8 30h104" className={TRAIT} strokeWidth="3" />
      <circle cx="18" cy="22" r="2.5" className="fill-current stroke-none" />
      <rect x="20" y="42" width="34" height="16" rx="4" className="fill-current opacity-70 stroke-none" />
      <rect x="64" y="42" width="34" height="16" rx="4" className="fill-current opacity-30 stroke-none" />
      <rect x="20" y="66" width="34" height="16" rx="4" className="fill-current opacity-30 stroke-none" />
      <rect x="64" y="66" width="34" height="16" rx="4" className="fill-current opacity-50 stroke-none" />
    </>
  ),
  // Un site en ligne : une fenêtre, un titre, une courbe d'audience.
  site: (
    <>
      <rect x="8" y="14" width="104" height="76" rx="8" className={TRAIT} strokeWidth="3" />
      <path d="M8 30h104" className={TRAIT} strokeWidth="3" />
      <rect x="20" y="40" width="46" height="7" rx="3.5" className="fill-current opacity-70 stroke-none" />
      <rect x="20" y="53" width="70" height="5" rx="2.5" className="fill-current opacity-30 stroke-none" />
      <path
        d="M22 80l18-13 15 8 18-19 15 10"
        className={TRAIT}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // Un chantier : la fenêtre en cours de construction, règle et crayon.
  chantier: (
    <>
      <rect x="8" y="14" width="104" height="76" rx="8" className={TRAIT} strokeWidth="3" />
      <path d="M8 30h104" className={TRAIT} strokeWidth="3" />
      <path d="M26 78V52m22 26V42m22 36V60m22 18V48" className={TRAIT} strokeWidth="4" strokeLinecap="round" />
      <path d="M18 78h84" className={TRAIT} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  // Un email : l'enveloppe, et la trace de l'envoi.
  email: (
    <>
      <rect x="14" y="26" width="92" height="60" rx="8" className={TRAIT} strokeWidth="3" />
      <path
        d="M18 34l38 27a10 10 0 0012 0l38-27"
        className={TRAIT}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="M4 44h14M4 58h10" className={TRAIT} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  // La prospection : une loupe sur une liste d'entreprises.
  prospection: (
    <>
      <rect x="8" y="16" width="72" height="72" rx="8" className={TRAIT} strokeWidth="3" />
      <path d="M22 36h34M22 50h44M22 64h26" className={TRAIT} strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="86" cy="62" r="20" className="fill-background stroke-current" strokeWidth="3.5" />
      <path d="M100 76l12 12" className={TRAIT} strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  // L'échéance : un calendrier avec une date entourée.
  calendrier: (
    <>
      <rect x="14" y="22" width="92" height="68" rx="8" className={TRAIT} strokeWidth="3" />
      <path d="M14 42h92" className={TRAIT} strokeWidth="3" />
      <path d="M36 14v14M84 14v14" className={TRAIT} strokeWidth="4" strokeLinecap="round" />
      <circle cx="46" cy="60" r="7" className="fill-current opacity-30 stroke-none" />
      <circle cx="74" cy="60" r="9" className={TRAIT} strokeWidth="3.5" />
      <circle cx="46" cy="78" r="5" className="fill-current opacity-20 stroke-none" />
      <circle cx="74" cy="78" r="5" className="fill-current opacity-20 stroke-none" />
    </>
  ),
  // La conclusion : la coche, et les éclats de la célébration.
  celebration: (
    <>
      <circle cx="60" cy="56" r="30" className={TRAIT} strokeWidth="3.5" />
      <path
        d="M46 56l10 10 20-22"
        className={TRAIT}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 24l7 7M106 24l-7 7M10 70h9M110 70h-9M60 14v9"
        className={TRAIT}
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </>
  ),
};

export function Pictogramme({
  cle,
  className,
  titre,
}: {
  cle: ClePictogramme;
  className?: string;
  /** Décrit ce que le dessin montre. Vide = décoratif. */
  titre?: string;
}) {
  return (
    <svg
      viewBox="0 0 120 104"
      className={cn('h-full w-full text-primary/80', className)}
      role={titre ? 'img' : 'presentation'}
      aria-label={titre || undefined}
      aria-hidden={titre ? undefined : true}
      focusable="false"
    >
      {DESSINS[cle]}
    </svg>
  );
}
