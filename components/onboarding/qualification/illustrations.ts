/**
 * Registre des illustrations de l'onboarding — POINT DE BRANCHEMENT UNIQUE.
 *
 * Chaque écran référence une clé ; ce fichier est le seul endroit où une clé
 * devient un chemin de fichier. Réaffecter un visuel à un écran ne demande
 * donc aucune modification de composant.
 *
 * Les visuels sont produits par l'agent `onboarding-visuals` et décrits dans
 * `public/onboarding/apps/manifest.json` (contrat stable). Deux variantes par
 * capture :
 *  - `desktop` (1848 px) : l'écran complet, barre latérale comprise ;
 *  - `compact` (1068 px) : cadrage resserré sur le contenu, lisible sur un
 *    téléphone où la barre latérale ne serait qu'une bouillie de pixels.
 *
 * Les images ont un fond transparent et portent déjà leurs coins arrondis,
 * leur liseré et leur ombre : le CSS ne doit RIEN rajouter autour (consigne
 * du manifeste). Le cadre en pointillés du composant `Illustration` ne sert
 * qu'à l'emplacement vide, jamais à l'image.
 */

export interface IllustrationSpec {
  /** Visuel pleine largeur, utilisé à partir de `lg`. */
  src: string;
  /** Variante resserrée, utilisée sous `lg`. Absente = on garde `src`. */
  srcCompact?: string;
  /**
   * Variantes en thème sombre. Les captures sont prises en thème clair : en
   * sombre, elles forment un bloc quasi blanc au centre de l'écran, la zone
   * la plus lumineuse de la page alors qu'elle ne porte aucune information.
   * Dès que l'agent visuels dépose les captures sombres, il suffit de
   * renseigner ces deux champs — le composant les prend sans autre
   * modification. Tant qu'elles manquent, `Illustration` retombe sur le
   * pictogramme vectoriel, qui hérite des variables de couleur.
   */
  srcSombre?: string;
  srcCompactSombre?: string;
  /**
   * Pictogramme vectoriel de la thématique — la variante MOBILE.
   *
   * Une capture de dashboard affichée à 343×146 px (une source déjà réduite
   * de 1848 à 1068 px) rend le texte de l'interface autour de 4 px de haut :
   * le client ne voit qu'un rectangle texturé. Sur les quatre questions, ça
   * fait quatre rectangles indistincts qui volent 18 à 24 % de la hauteur aux
   * réponses. Sous `lg`, on affiche donc un dessin qui SUPPORTE 120–150 px de
   * haut, et qui hérite des couleurs du thème (donc pas de bloc blanc en
   * sombre).
   */
  pictogramme: ClePictogramme;
  /** Texte alternatif — décrit ce que le visuel montre, pas « illustration ». */
  alt: string;
  /** Légende de l'emplacement, affichée tant que le fichier n'existe pas. */
  attendu: string;
}

/** Les dessins vectoriels disponibles (cf. `Pictogramme.tsx`). */
export type ClePictogramme =
  | 'espace'
  | 'site'
  | 'chantier'
  | 'email'
  | 'prospection'
  | 'calendrier'
  | 'celebration';

const BASE = '/onboarding/apps';

export const ILLUSTRATIONS = {
  accueil: {
    src: `${BASE}/hub-espace-client-desktop.webp`,
    srcCompact: `${BASE}/hub-espace-client-compact.webp`,
    pictogramme: 'espace',
    alt: 'L’espace de travail Veridian, avec les outils du client réunis au même endroit',
    attendu: 'Dashboard Hub — vue d’ensemble des apps du client',
  },
  'site-actuel': {
    src: `${BASE}/analytics-tableau-bord-desktop.webp`,
    srcCompact: `${BASE}/analytics-tableau-bord-compact.webp`,
    pictogramme: 'site',
    alt: 'Tableau de bord Veridian Analytics montrant l’audience d’un site',
    attendu: 'Dashboard Analytics — audience du site',
  },
  'site-intention': {
    src: `${BASE}/analytics-explorer-desktop.webp`,
    srcCompact: `${BASE}/analytics-explorer-compact.webp`,
    pictogramme: 'chantier',
    alt: 'Exploration détaillée des pages et des visiteurs d’un site',
    attendu: 'Analytics Explorer — pages et parcours',
  },
  'site-creation': {
    src: `${BASE}/analytics-explorer-desktop.webp`,
    srcCompact: `${BASE}/analytics-explorer-compact.webp`,
    pictogramme: 'site',
    alt: 'Un site Veridian et les pages que ses visiteurs consultent',
    attendu: 'Analytics Explorer — pages et parcours',
  },
  emailing: {
    src: `${BASE}/mail-contacts-desktop.webp`,
    srcCompact: `${BASE}/mail-contacts-compact.webp`,
    pictogramme: 'email',
    alt: 'Base de contacts de Veridian Mail, avec les listes et les attributs',
    attendu: 'Dashboard Veridian Mail — base de contacts',
  },
  prospection: {
    src: `${BASE}/prospection-base-b2b-desktop.webp`,
    srcCompact: `${BASE}/prospection-base-b2b-compact.webp`,
    pictogramme: 'prospection',
    alt: 'Les coordonnées d’entreprises françaises dans Veridian Prospection',
    attendu: 'Dashboard Prospection — base d’entreprises',
  },
  recapitulatif: {
    src: `${BASE}/hub-espace-client-desktop.webp`,
    srcCompact: `${BASE}/hub-espace-client-compact.webp`,
    pictogramme: 'celebration',
    alt: 'L’espace Veridian du client, avec ses applications activées',
    attendu: 'Dashboard Hub avec les apps activées',
  },
  echeance: {
    src: `${BASE}/hub-espace-client-desktop.webp`,
    srcCompact: `${BASE}/hub-espace-client-compact.webp`,
    pictogramme: 'calendrier',
    alt: 'L’espace Veridian du client, prêt à accueillir son projet',
    attendu: 'Dashboard Hub — le projet à planifier',
  },
  // `satisfies` et non une annotation `Record<string, …>` : c'est ce qui
  // permet à `keyof typeof` de valoir l'union réelle des clés. Avec un
  // `Record<string, …>`, `CleIllustration` dégénérait en `string` et une clé
  // mal orthographiée passait la compilation.
} satisfies Record<string, IllustrationSpec>;

/**
 * Les clés valides du registre.
 *
 * `EcranQuestion.illustration` est typé là-dessus : une clé mal orthographiée
 * ne compile plus, au lieu de produire un cadre pointillé « Visuel manquant »
 * en production sans la moindre erreur.
 */
export type CleIllustration = keyof typeof ILLUSTRATIONS;

/** Récupère une spec, avec un repli lisible si la clé est inconnue. */
export function getIllustration(cle: string): IllustrationSpec {
  return (
    (ILLUSTRATIONS as Record<string, IllustrationSpec>)[cle] ?? {
      src: '',
      pictogramme: 'espace',
      alt: '',
      attendu: `Visuel manquant pour « ${cle} »`,
    }
  );
}
