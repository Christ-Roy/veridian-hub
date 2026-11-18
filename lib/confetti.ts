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

  const base: confetti.Options = {
    spread: 70,
    startVelocity: 45,
    ticks: 200,
    gravity: 0.9,
    scalar: 1.05,
    colors: VERIDIAN_COLORS,
    zIndex: 9999,
  };

  // Salve depuis le coin bas-gauche
  confetti({ ...base, angle: 60, particleCount: 90, origin: { x: 0, y: 1 } });
  // Salve depuis le coin bas-droit
  confetti({ ...base, angle: 120, particleCount: 90, origin: { x: 1, y: 1 } });
}
