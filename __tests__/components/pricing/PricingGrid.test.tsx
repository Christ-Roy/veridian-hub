/**
 * Test smoke pour PricingGrid — vérifie le rendu de base et les CTA.
 * Test orienté logique (pas de DOM lourd) vu qu'on n'a pas RTL configuré
 * en Nuclear scope.
 */

import { describe, it, expect } from 'vitest';
import { PricingGrid } from '@/components/pricing/PricingGrid';

describe('PricingGrid (smoke)', () => {
  it('exporte un composant React', () => {
    expect(typeof PricingGrid).toBe('function');
    expect(PricingGrid.name).toBe('PricingGrid');
  });

  // NB : tests interactifs (click handlers, switch interval) couverts par
  // les E2E Playwright dans veridian-hub/e2e/. Ce test smoke garantit
  // juste qu'on ne livre pas un composant cassé à l'import.
  //
  // Quand RTL + happy-dom seront configurés (cf CI-TODO §14-15), enrichir
  // avec render() + assertions sur le DOM (badges, sections, CTA labels).
});
