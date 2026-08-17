import confetti from 'canvas-confetti';

/** Couleurs du gradient Veridian (jaune → orange → rose → violet). */
const VERIDIAN_COLORS = ['#fbe7a8', '#fbc56b', '#f0a6c0', '#c9a6e8', '#8b78ff'];

/**
 * Explosion de confettis aux couleurs Veridian — célébration d'une action
 * réussie (activation d'un service, etc.). Deux salves légèrement décalées
 * partant des deux coins bas pour un effet plein écran.
 *
 * No-op si `prefers-reduced-motion` est actif (respect accessibilité).
 */
export function celebrate(): void {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  // Sur mobile, deux grosses salves recouvraient le récapitulatif et son CTA
  // pendant plusieurs secondes. La célébration reste visible, sans masquer
  // l'information que le client vient précisément de terminer de saisir.
  const compact = window.innerWidth < 640;

  const base: confetti.Options = {
    spread: 70,
    startVelocity: compact ? 28 : 40,
    ticks: compact ? 90 : 150,
    gravity: 0.9,
    scalar: compact ? 0.8 : 1,
    colors: VERIDIAN_COLORS,
    zIndex: 9999,
  };

  const particleCount = compact ? 35 : 80;

  // Salve depuis le coin bas-gauche
  confetti({ ...base, angle: 60, particleCount, origin: { x: 0, y: 1 } });
  // Salve depuis le coin bas-droit
  confetti({ ...base, angle: 120, particleCount, origin: { x: 1, y: 1 } });
}
