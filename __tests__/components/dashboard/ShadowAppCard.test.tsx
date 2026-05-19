/**
 * Test smoke pour ShadowAppCard — garantit l'import + export.
 * Tests interactifs (modal, click marketing_url) couverts par E2E Playwright.
 */

import { describe, it, expect } from 'vitest';
import { ShadowAppCard } from '@/app/dashboard/components/ShadowAppCard';

describe('ShadowAppCard (smoke)', () => {
  it('exporte un composant React', () => {
    expect(typeof ShadowAppCard).toBe('function');
    expect(ShadowAppCard.name).toBe('ShadowAppCard');
  });

  // Tests UI interactifs renvoyés à E2E Playwright (cf veridian-hub/e2e/).
  // Le rendu visuel + modal + ouverture lien marketing_url sera validé
  // dans le smoke navigateur (CONTRAT-HUB §11.5.2).
});
